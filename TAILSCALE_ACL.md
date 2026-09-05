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

## 2. Tailnet (ACL) → reservado para más adelante

El `serve` tailnet (`:8443`) está **apagado por ahora** (no se usa; era 100%
interno, sin exposición pública). Si algún día se quiere acceso solo-tailnet
además del Funnel:

```bash
incus exec mcp-http -- tailscale serve --bg --https=8443 http://127.0.0.1:8080
```

y pegar en Admin → Access controls:

```json
{
  "grants": [
    {
      "src": ["ramgeart@", "n01grafr"],
      "dst": ["mcp-http"],
      "ip": ["tcp:8443"]
    }
  ]
}
```

- `src`: quién consumiría el MCP por tailnet. `n01grafr` para healthchecks y
  verificación desde el host. Agregar tags/usuarios según corresponda
  (ej: `"tag:llm-clients"`); mínimo privilegio.
- `dst: ["mcp-http"]` = el nodo container (`100.89.187.122`). Solo el puerto del
  serve que se habilite (ej: 8443).
- Sintaxis legacy equivalente:
  `{"action": "accept", "src": ["ramgeart@", "n01grafr"], "dst": ["mcp-http:8443"]}`

### Verificar el path tailnet (cuando se habilite)

```bash
T=$(grep MCP_HTTP_TOKEN /etc/mcp-http/env | cut -d= -f2)
curl -s https://mcp-http.tailea1bd3.ts.net:8443/healthz
# ciclo initialize → notifications (202) → tools/call → DELETE (200) con
# Authorization: Bearer $T, igual que contra el Funnel (cambia solo host:puerto)
```

## Topología actual (solo Funnel + LAN operativa)

| Path | TLS | Auth | Pasa por ACL tailnet |
|---|---|---|---|
| Internet → Funnel en `mcp-http` (`:443`) | Funnel | Bearer | No: el Funnel es internet público por diseño, no acepta grants; su auth es el Bearer. |
| Host → `10.150.119.65:8080` (LAN Incus, operativas) | No | Bearer | No (red del hipervisor) |

> El host quedó fuera del path: sin funnel, sin proxy, sin servicio local
> (queda apagado como rollback). El Funnel corre con la identidad del propio
> nodo `mcp-http`, bajo tu ACL como cualquier server.
