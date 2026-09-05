# Servidor MCP sobre Streamable HTTP (spec 2025-03-26)

Expone **las mismas tools del modo stdio** (`src/server.ts`) a través de un
endpoint HTTP compatible con la
[spec Streamable HTTP 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http).
Implementado en `src/http.ts` → se compila a `dist/http.js` con el `npm run build` normal.

Diseñado para correr en `127.0.0.1` **detrás de un Tailscale Funnel**.
La seguridad la aporta un **Bearer token** (comparado en tiempo constante),
más la protección anti DNS-rebinding del SDK.

> Requiere `@modelcontextprotocol/sdk >= 1.10` (el repo ya trae `^1.30.0`).
> La 1.9.0 original **no** incluía este transporte.

## Quickstart local

```bash
npm install
npm run build

export MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
echo "TOKEN=$MCP_HTTP_TOKEN"
npm run serve:http
# MCP Streamable HTTP (stateful) en http://127.0.0.1:8080/mcp
```

Probar el ciclo completo (spec: `initialize` → `notifications/initialized` →
requests con sesión → `DELETE`):

```bash
BASE=http://127.0.0.1:8080
H="Authorization: Bearer $MCP_HTTP_TOKEN"
CT="Content-Type: application/json"
AC="Accept: application/json, text/event-stream"

curl -s $BASE/healthz
# {"status":"ok","name":"desktop-commander","version":"0.2.40","transport":"streamable-http"}

SID=$(curl -s -D - -o /tmp/init.out -X POST $BASE/mcp -H "$H" -H "$CT" -H "$AC" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cli","version":"1.0"}}}' \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
echo "SID=$SID"

curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/mcp -H "$H" -H "$CT" -H "$AC" \
  -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
# 202

curl -s -X POST $BASE/mcp -H "$H" -H "$CT" -H "$AC" \
  -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

curl -s -o /dev/null -w "%{http_code}\n" -X DELETE $BASE/mcp -H "$H" -H "Mcp-Session-Id: $SID"
# 200
```

Códigos que implementa (vía SDK): `401` sin token · `400` request sin sesión ·
`404` sesión inexistente/cerrada (el cliente debe reinicializar) ·
`202` solo-notifications · `200` initialize/requests (JSON o SSE según el caso).

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `MCP_HTTP_TOKEN` | *(vacío)* | **Obligatorio.** Bearer token del endpoint `/mcp`. Si falta y no hay `MCP_HTTP_NO_AUTH=1`, el proceso no arranca. |
| `MCP_HTTP_PORT` | `8080` | Puerto de escucha. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Interfaz de escucha. No usar `0.0.0.0` salvo que sepas lo que hacés. |
| `MCP_HTTP_PATH` | `/mcp` | Ruta del endpoint MCP (`POST` + `GET` + `DELETE`). |
| `MCP_HTTP_STATELESS` | *(off)* | `=1` desactiva sesiones (`Mcp-Session-Id`). Útil si el cliente no guarda sesión; se pierde `GET` standalone por sesión. |
| `MCP_HTTP_BODY_LIMIT` | `10mb` | Límite del body JSON (hay tools que mueven archivos enteros). |
| `MCP_HTTP_ALLOWED_HOSTS` | `127.0.0.1,localhost` (+ puerto) | Hosts extra para la protección anti-rebinding. **Tras Funnel hay que agregar `<nodo>.ts.net`** (el header `Host` debe matchear exacto o todo da `400`). |
| `MCP_HTTP_ALLOWED_ORIGINS` | *(sin chequear)* | Origins de navegador permitidos. Si se define, cualquier request con `Origin` fuera de la lista se rechaza. Clientes API no mandan `Origin`, no les afecta. |
| `MCP_HTTP_NO_AUTH` | *(off)* | `=1` desactiva el token. **Solo desarrollo local, nunca tras Funnel.** |

## Despliegue tras Tailscale Funnel (bundle)

El bundle es: `dist/` compilado + `node_modules` (o la imagen Docker) + estas
variables. TLS lo termina el Funnel; el servidor solo escucha en localhost.

**1. Build**

```bash
npm install --omit=dev   # o npm install completo si vas a compilar ahí
npm run build            # genera dist/http.js (ya incluido en tsc por src/**/*.ts)
```

**2. Token**

```bash
openssl rand -hex 32   # guardarlo en el gestor de secretos, va en MCP_HTTP_TOKEN
```

**3. systemd (ejemplo en el host/container)**

```ini
[Unit]
Description=bashun-commander MCP Streamable HTTP
After=network-online.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=/opt/bashun-commander
Environment=MCP_HTTP_TOKEN=<pegar-token>
Environment=MCP_HTTP_ALLOWED_HOSTS=mi-nodo.ts.net
ExecStart=/usr/bin/node dist/http.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

**4. Funnel**

```bash
tailscale funnel 8080
# expone https://mi-nodo.ts.net  →  http://127.0.0.1:8080
# el endpoint MCP queda en https://mi-nodo.ts.net/mcp
```

⚠️ Si el Funnel responde `400` a todo: falta el hostname en
`MCP_HTTP_ALLOWED_HOSTS` (ver tabla). Si responde `401`: falta/está mal el
header `Authorization: Bearer <token>`.

**5. Docker**

```bash
docker build -t bashun-commander .
docker run -d --restart unless-stopped --name mcp-http \
  -e MCP_HTTP_TOKEN=<token> \
  -e MCP_HTTP_ALLOWED_HOSTS=mi-nodo.ts.net \
  -p 127.0.0.1:8080:8080 \
  bashun-commander node dist/http.js
```

## Configurar un cliente

Cualquier cliente MCP con transporte Streamable HTTP:

- **URL:** `https://mi-nodo.ts.net/mcp` (o `http://127.0.0.1:8080/mcp` en local)
- **Header en cada request:** `Authorization: Bearer <token>`
- **Headers MCP:** `Accept: application/json, text/event-stream` (+ `Content-Type: application/json` en POST)
- **Sesiones:** guardar el `mcp-session-id` de la respuesta al `initialize` y
  reenviarlo como `Mcp-Session-Id`; ante `404`, reinicializar.

## Limitaciones conocidas

- **Estado compartido:** una sola instancia `server` atiende todas las sesiones
  HTTP (config, sesiones de procesos, búsquedas). Bien para uso unipersonal
  tras Funnel; no es multi-tenant.
- **Sin resumabilidad:** no se configura `eventStore`, así que no hay replay con
  `Last-Event-ID` (la spec lo deja opcional).
- **Sin relación con `remote-server/`:** ese stub implementa el flow
  device-code de `remote-device`; este endpoint es el protocolo MCP estándar y
  usa su propio token.
- **Rotación del token:** requiere reiniciar el proceso (está en memoria).
