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
| `MCP_HTTP_MAX_SESSIONS` | `50` | Máximo de sesiones concurrentes. Superado → `503`. Cada sesión tiene su propia instancia del Server (aisladas entre sí; un `DELETE` solo cierra la propia). |
| `MCP_HTTP_SESSION_TTL_MS` | `300000` (5 min) | Expira sesiones sin actividad (scanners que nunca mandan `DELETE`). `0` = sin expiración. |
| `MCP_HTTP_BODY_LIMIT` | `10mb` | Límite del body JSON (hay tools que mueven archivos enteros). |
| `MCP_HTTP_ALLOWED_HOSTS` | `127.0.0.1,localhost` (+ puerto) | Hosts extra para la protección anti-rebinding. **Tras Funnel hay que agregar `<nodo>.ts.net`** (el header `Host` debe matchear exacto o todo da `400`). |
| `MCP_HTTP_ALLOWED_ORIGINS` | *(sin chequear)* | Origins de navegador permitidos. Si se define, cualquier request con `Origin` fuera de la lista se rechaza. Clientes API no mandan `Origin`, no les afecta. |
| `MCP_HTTP_NO_AUTH` | *(off)* | `=1` desactiva el token. **Solo desarrollo local, nunca tras Funnel.** |

## Despliegue tras Tailscale Funnel (bundle)

El bundle es: `dist/` compilado + `node_modules` (o la imagen Docker) + estas
variables. TLS lo termina el Funnel; el servidor solo escucha en localhost.

### Vía script (recomendado, idempotente)

`scripts/deploy-http.sh` reproduce exactamente el despliegue de referencia:
instala deps + compila si hace falta, **reutiliza el token existente** (solo
genera uno si no hay), escribe `/etc/mcp-http/env` (600) y la unidad
`mcp-http.service`, la habilita/arranca, verifica `/healthz` y aplica
`tailscale serve` y/o `funnel`. Re-ejecutarlo es seguro.

```bash
sudo ./scripts/deploy-http.sh --funnel
# flags: [--serve|--no-serve] [--funnel] [--port 8080] [--host mi-nodo.ts.net]
#        [--token <hex>] [--skip-install] [--skip-build]
#        (o vars APP_DIR / ENV_FILE / SERVICE / MCP_HTTP_PORT / MCP_HTTP_TOKEN)
```

El Funnel requiere dos permisos previos en la consola admin (una sola vez):
`https://login.tailscale.com/f/funnel?node=<tu-nodo>` → habilitar Funnel en la
tailnet **y** agregar el nodo a la lista de permitidos. Sin eso el script avisa
y deja andando el `serve` de tailnet.

### Variante: servicio en un container Incus (Debian 13)

Así corre en producción: servicio + tailscaled + serve/funnel viven en el
container `mcp-http`, con su propia identidad tailnet (bajo el ACL). El host no
participa del path (su funnel/proxy/servicio se retiraron tras el cutover).

```bash
# 1. Container + Node (los binarios del repo piden node >= 18) + TUN para tailscale
incus launch images:debian/13 mcp-http --config boot.autostart=true
incus config device add mcp-http tun unix-char path=/dev/net/tun
incus restart mcp-http   # el TUN necesita restart para montarse
incus exec mcp-http -- apt-get update
incus exec mcp-http -- apt-get install -y git curl openssl nodejs npm

# 2. Tailscale dentro (repo oficial) + login (imprime URL de aprobación una sola vez)
incus exec mcp-http -- sh -c 'curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg'
incus exec mcp-http -- sh -c 'curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list'
incus exec mcp-http -- sh -c 'apt-get update && apt-get install -y tailscale'
incus exec mcp-http -- tailscale login   # aprobar en la URL que imprime

# 3. Código + mismo token del host (los clientes no cambian)
incus exec mcp-http -- git clone --depth 1 \
  https://github.com/ramgeart/DesktopCommanderMCP.git /opt/bashun-commander
incus exec mcp-http -- mkdir -p /etc/mcp-http
incus file push /etc/mcp-http/env mcp-http/etc/mcp-http/env

# 4. Deploy dentro (sin serve/funnel del host).
#    OJO: MCP_HTTP_HOST=0.0.0.0 para servir a tailscaled + red Incus
incus exec mcp-http -- sh -c 'cd /opt/bashun-commander && \
  MCP_HTTP_HOST=0.0.0.0 ./scripts/deploy-http.sh --no-serve \
  --host mcp-http.tailea1bd3.ts.net'

# 5. Funnel propio (:443, público) desde el container.
incus exec mcp-http -- tailscale funnel --bg 8080
# (puede pedir aprobación: habilitarlo + agregar el nodo
#  en https://login.tailscale.com/f/funnel)
#
# Opcional, solo si se quiere además un endpoint solo-tailnet bajo ACL:
# incus exec mcp-http -- tailscale serve --bg --https=8443 http://127.0.0.1:8080
# (ver "Tailnet (ACL)" en TAILSCALE_ACL.md; hoy apagado, no se usa)

# 6. Cutover: retirar el funnel/proxy/servicio viejos del host
tailscale funnel --https=443 off
incus config device remove mcp-http proxy8080
systemctl stop mcp-http && systemctl disable mcp-http
```

URLs finales: público `https://mcp-http.tailea1bd3.ts.net/mcp` (Funnel+Bearer),
tailnet `https://mcp-http.tailea1bd3.ts.net:8443/mcp` (Bearer+grants, ver
`TAILSCALE_ACL.md`).

Rollback: re-agregar el proxy + `systemctl enable --now mcp-http` en el host
(el checkout de `/root` sigue ahí) y `tailscale funnel --bg 8080` en el host.

### Manual (lo que hace el script, paso a paso)

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
Description=bashun-commander MCP Streamable HTTP (tras Tailscale serve/funnel)
After=network-online.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=/opt/bashun-commander   # o la ruta del repo
EnvironmentFile=/etc/mcp-http/env        # MCP_HTTP_TOKEN + MCP_HTTP_ALLOWED_HOSTS
ExecStart=/usr/bin/node dist/http.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

(El script genera esta unidad con el `WorkingDirectory` del repo donde corre.)

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

## Widgets UI (desactivados por ahora)

El servidor trae dos plantillas MCP Apps heredadas del upstream
(`ui://desktop-commander/config-editor` y `ui://desktop-commander/file-preview`,
en `src/ui/`). Con ellas anunciadas, el submission de plugins de OpenAI exige
**por plantilla**: `_meta.ui.domain` (dominio único) y `_meta.ui.csp`
(`connectDomains` / `resourceDomains`), que este fork no declara — de ahí los
errores *"CSP del widget no configurada"* y *"dominio del widget no
configurado"*. No son errores de runtime: las 26 tools funcionan sin widgets.

Por eso vienen **apagadas por default** (`MCP_UI_RESOURCES` distinto de `1`):
no aparecen en `resources/list`, `resources/read` las rechaza y las tools no
las referencian en `_meta`. Para reactivarlas (solo stdio/local u otro
servidor, no cambia el endpoint HTTP):

```bash
MCP_UI_RESOURCES=1 node dist/http.js   # o agregarlo a /etc/mcp-http/env
```

### Notas de dominios (para cuando se reactiven)

- El `domain` del widget es **identidad, no conectividad**: el HTML viaja
  inline en el `resources/read` y el widget habla por `postMessage`, nunca hace
  HTTPS a tu servidor. No necesita CNAME ni DNS que apunte a ningún lado; con
  que el dominio sea tuyo y lo verifiques en el submission alcanza. Usar un
  subdominio único por plantilla (ej: `dc-config` / `dc-preview`).
- Un **CNAME al hostname del Funnel NO sirve para exponer el MCP en tu
  dominio**: el ingress de Tailscale enruta por SNI y termina TLS con cert para
  `*.ts.net`, así que el TLS falla. Para `https://tu-dominio/mcp` hay que hacer
  `A record` a la IP pública del host + terminar TLS localmente
  (Caddy/nginx → proxy a `127.0.0.1:8080`).
- Trabajo pendiente para submitir con widgets: implementar `getMeta()` en
  `src/ui/resources.ts` devolviendo por plantilla
  `_meta: { ui: { domain, csp: { connectDomains, resourceDomains } } }`
  (nuestros templates ya hacen inline total, así que `resourceDomains` puede ir
  vacío), versionar las URIs (`ui://.../v1.html`) y re-escanear.

## Limitaciones conocidas

- **Sesiones aisladas, config compartida:** cada `Mcp-Session-Id` tiene su
  propia instancia del Server (un `DELETE` no afecta a las demás), pero la
  configuración, el historial de tools y las stats de uso son globales al
  proceso. Bien para uso unipersonal tras Funnel; no es multi-tenant.
- **Sesiones sin `DELETE` quedan en memoria** hasta el tope
  (`MCP_HTTP_MAX_SESSIONS`, luego `503`). Los clientes bien portados mandan
  `DELETE` al terminar.
- **Sin resumabilidad:** no se configura `eventStore`, así que no hay replay con
  `Last-Event-ID` (la spec lo deja opcional).
- **Sin relación con `remote-server/`:** ese stub implementa el flow
  device-code de `remote-device`; este endpoint es el protocolo MCP estándar y
  usa su propio token.
- **Rotación del token:** requiere reiniciar el proceso (está en memoria).
