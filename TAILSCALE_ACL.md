# Auth del MCP: Funnel (Bearer) + Tailnet ACL

Dos capas independientes. Ninguna reemplaza a la otra.

## 1. Funnel público (internet) → Bearer token

`https://n01grafr.tailea1bd3.ts.net/mcp` (Funnel en el host, proxy a `mcp-http:8080`).

- Auth: header `Authorization: Bearer <token>` en cada request. Sin token → `401`.
- El token vive en `/etc/mcp-http/env` (`MCP_HTTP_TOKEN`, modo 600) **tanto en el
  host como en el container** (mantenerlos iguales; el host es fallback apagado).
- Comparación en tiempo constante; nunca va en query params (quedan en logs).

### Rotar el token

```bash
NEW=$(openssl rand -hex 32)
incus exec mcp-http -- sh -c "sed -i 's/^MCP_HTTP_TOKEN=.*/MCP_HTTP_TOKEN=$NEW/' /etc/mcp-http/env && systemctl restart mcp-http"
sed -i "s/^MCP_HTTP_TOKEN=.*/MCP_HTTP_TOKEN=$NEW/" /etc/mcp-http/env
# verificar: token viejo → 401, nuevo → ciclo initialize/202/DELETE ok
```

Luego actualizar el token en cada cliente (opencode/Claude/inspector).

## 2. Tailnet (ACL) → `mcp-http:443`

`https://mcp-http.tailea1bd3.ts.net/mcp` (`tailscale serve` dentro del container).
El Funnel **no** pasa por el ACL de tailnet; este path sí: sin grants, da timeout
(aunque haya Bearer válido). Pegar en Admin → Access controls:

```json
{
  "grants": [
    {
      "src": ["ramgeart@", "n01grafr"],
      "dst": ["mcp-http"],
      "ip": ["tcp:443"]
    }
  ]
}
```

- `src`: quién consume el MCP. `n01grafr` está incluido para healthchecks y
  verificación desde el host. Agregar tags/usuarios según corresponda
  (ej: `"tag:llm-clients"`); mínimo privilegio.
- `dst: ["mcp-http"]` = el nodo container (`100.89.187.122`). Solo puerto 443.
- Sintaxis legacy equivalente:
  `{"action": "accept", "src": ["ramgeart@", "n01grafr"], "dst": ["mcp-http:443"]}`

### Verificar tras aplicar el ACL (desde un origen permitido)

```bash
T=$(grep MCP_HTTP_TOKEN /etc/mcp-http/env | cut -d= -f2)
curl -s https://mcp-http.tailea1bd3.ts.net/healthz
# ciclo initialize → notifications (202) → tools/call → DELETE (200) con
# Authorization: Bearer $T, igual que contra el Funnel
```

## Topología actual (un path público, un path tailnet)

| Path | TLS | Auth | Pasa por ACL tailnet |
|---|---|---|---|
| Internet → Funnel en host → proxy → `mcp-http:8080` | Funnel | Bearer | No: el Funnel es internet público por diseño, no acepta grants; su auth es el Bearer. Ya aprobado para este nodo. |
| Tailnet → `mcp-http:443` (serve en container) | Tailscale | Bearer + grants de abajo | **Sí** |
| Host → `10.150.119.65:8080` (LAN Incus, operativas) | No | Bearer | No (red del hipervisor) |

> El `serve` tailnet del host se apagó a propósito (`tailscale serve
> --https=443 off`; ojo: ese comando también voltea el funnel, reactivarlo
> después con `tailscale funnel --bg 8080`). Así hay un solo endpoint tailnet
> (`mcp-http`) y un solo endpoint público (Funnel), sin superficies duplicadas.
