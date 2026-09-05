#!/usr/bin/env bash
#
# Despliega el servidor MCP Streamable HTTP (src/http.ts) como servicio systemd
# + Tailscale serve (tailnet) y/o funnel (internet público).
#
# Reproduce el despliegue de referencia:
#   - env en /etc/mcp-http/env (token + allowed hosts), modo 600
#   - unidad systemd mcp-http.service (node dist/http.js en 127.0.0.1:PUERTO)
#   - tailscale serve --https=443 (tailnet) y opcionalmente tailscale funnel
#
# Idempotente: re-ejecutar NO rota el token existente, NO rompe sesiones más
# allá del restart del servicio, y re-aplica serve/funnel.
#
# Uso:
#   sudo ./scripts/deploy-http.sh [--serve] [--funnel] [--port 8080]
#                                  [--host mi-nodo.ts.net] [--token <hex>]
#                                  [--skip-install] [--skip-build]
#
# Vars de entorno equivalentes: APP_DIR, ENV_FILE, SERVICE, MCP_HTTP_PORT,
# MCP_HTTP_TOKEN, MCP_HTTP_ALLOWED_HOSTS (extras, coma-separados).
#
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/mcp-http/env}"
SERVICE="${SERVICE:-mcp-http}"
PORT="${MCP_HTTP_PORT:-8080}"
BIND="${MCP_HTTP_HOST:-127.0.0.1}"
WANT_SERVE=1
WANT_FUNNEL=0
SKIP_INSTALL=0
SKIP_BUILD=0
TOKEN_ARG=""
HOST_ARG=""
EXTRA_HOSTS="${MCP_HTTP_ALLOWED_HOSTS:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --serve) WANT_SERVE=1; shift ;;
    --no-serve) WANT_SERVE=0; shift ;;
    --funnel) WANT_FUNNEL=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST_ARG="$2"; shift 2 ;;
    --token) TOKEN_ARG="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) sed -n '2,/^#$/p' "$0"; exit 0 ;;
    *) echo "flag desconocida: $1 (ver --help)" >&2; exit 1 ;;
  esac
done

log() { echo "--> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "correr como root (sudo)"
command -v node >/dev/null || die "node no encontrado"
command -v openssl >/dev/null || die "openssl no encontrado"
if [ "$WANT_SERVE" -eq 1 ] || [ "$WANT_FUNNEL" -eq 1 ]; then
  command -v tailscale >/dev/null || die "tailscale no encontrado (o usar --no-serve sin --funnel)"
fi
[ -f "$APP_DIR/package.json" ] || die "no hay package.json en $APP_DIR"
[ -f "$APP_DIR/src/http.ts" ] || die "no hay src/http.ts en $APP_DIR (¿repo desactualizado?)"
node -e "const [m,M]=process.versions.node.split('.').map(Number); if (m<18){process.exit(1)}" \
  || die "node >= 18 requerido"

# --- 1. deps + build ---------------------------------------------------------
if [ "$SKIP_INSTALL" -eq 0 ] && [ ! -d "$APP_DIR/node_modules" ]; then
  log "npm install en $APP_DIR"
  (cd "$APP_DIR" && npm install --no-audit --no-fund)
fi
NEEDS_BUILD=0
if [ "$SKIP_BUILD" -eq 0 ]; then
  if [ ! -f "$APP_DIR/dist/http.js" ]; then
    NEEDS_BUILD=1
  else
    while IFS= read -r f; do
      if [ "$f" -nt "$APP_DIR/dist/http.js" ]; then NEEDS_BUILD=1; break; fi
    done < <(find "$APP_DIR/src" -name '*.ts')
  fi
fi
if [ "$NEEDS_BUILD" -eq 1 ]; then
  log "npm run build"
  (cd "$APP_DIR" && npm run build)
else
  log "build al día (dist/http.js)"
fi

# --- 2. hostname tailnet (para allowedHosts + URLs) ---------------------------
TAIL_HOST="$HOST_ARG"
if [ -z "$TAIL_HOST" ] && command -v tailscale >/dev/null; then
  TAIL_HOST="$(tailscale status --json 2>/dev/null | grep -o '"DNSName": *"[^"]*"' | head -n 1 | cut -d'"' -f4 | sed 's/\.$//')"
fi
if [ -z "$TAIL_HOST" ]; then
  # Sin tailscaled (ej: dentro de un container Incus, donde serve/funnel los
  # expone el host): usar el primer host permitido como referencia.
  TAIL_HOST="$(echo "$EXTRA_HOSTS" | cut -d, -f1 | xargs)"
fi
[ -n "$TAIL_HOST" ] || die "no pude detectar el hostname tailnet (¿tailscale logueado?). Pasalo con --host"

# --- 3. token (se reutiliza el existente si hay) ------------------------------
TOKEN="$TOKEN_ARG"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN="$(grep -E '^MCP_HTTP_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 32)"
  log "token nuevo generado"
else
  log "token existente reutilizado (no se rota)"
fi

# --- 4. env file --------------------------------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"
ALLOWED="$TAIL_HOST"
[ -z "$EXTRA_HOSTS" ] || ALLOWED="$ALLOWED,$EXTRA_HOSTS"
printf 'MCP_HTTP_TOKEN=%s\nMCP_HTTP_PORT=%s\nMCP_HTTP_HOST=%s\nMCP_HTTP_ALLOWED_HOSTS=%s\n' \
  "$TOKEN" "$PORT" "$BIND" "$ALLOWED" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
log "env escrito en $ENV_FILE (600)"

# --- 5. unidad systemd ---------------------------------------------------------
UNIT="/etc/systemd/system/${SERVICE}.service"
NODE_BIN="$(command -v node)"
cat > "$UNIT" <<EOF
[Unit]
Description=bashun-commander MCP Streamable HTTP (tras Tailscale serve/funnel)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/http.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null
log "systemd: $SERVICE habilitado y arrancado"

# --- 6. healthcheck local ------------------------------------------------------
for i in $(seq 1 15); do
  if curl -sS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    log "healthcheck local OK (intento $i)"
    break
  fi
  [ "$i" -eq 15 ] && die "el servicio no respondió en 127.0.0.1:$PORT (ver journalctl -u $SERVICE)"
  sleep 2
done

# --- 7. tailscale serve (tailnet) ----------------------------------------------
if [ "$WANT_SERVE" -eq 1 ]; then
  log "tailscale serve --https=443 -> 127.0.0.1:$PORT"
  tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}" 2>&1 | head -n 6 || true
fi

# --- 8. tailscale funnel (internet) --------------------------------------------
if [ "$WANT_FUNNEL" -eq 1 ]; then
  log "tailscale funnel --bg $PORT"
  if timeout 90 tailscale funnel --bg "$PORT" > /tmp/mcp-funnel-deploy.log 2>&1; then
    log "funnel activado"
  else
    echo "WARN: funnel no se activó (sale $?). Causa probable: falta habilitarlo"
    echo "para este nodo en la consola admin. Detalle:"
    head -n 8 /tmp/mcp-funnel-deploy.log || true
  fi
fi

# --- 9. resumen -----------------------------------------------------------------
echo ""
echo "Despliegue listo:"
echo "  servicio : systemctl status $SERVICE"
echo "  local    : http://127.0.0.1:${PORT}/mcp  (+ /healthz)"
if [ "$WANT_SERVE" -eq 1 ]; then
  echo "  tailnet  : https://${TAIL_HOST}/mcp"
fi
if tailscale funnel status 2>/dev/null | grep -q "Funnel on"; then
  echo "  funnel   : https://${TAIL_HOST}/mcp  (internet público)"
fi
echo "  token    : $TOKEN"
echo ""
echo "Probar:"
echo "  curl -s https://${TAIL_HOST}/healthz"
echo "  # y el ciclo initialize/tools/list con: Authorization: Bearer \$TOKEN"
