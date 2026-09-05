# bashun-commander

**Fork limpio y local de DesktopCommanderMCP** - Sin telemetría, sin servidores remotos, 100% local.

## Características
- Control total del terminal desde Claude / Cursor / etc.
- Búsqueda en filesystem
- Edición de archivos con diff
- Todo corre localmente
- Sin tracking ni datos enviados a ningún lado

## Instalación
```bash
npx ramgeart/bashun-commander@latest setup
```

## Servidor remoto (Streamable HTTP, spec 2025-03-26)

El mismo servidor también se expone por HTTP para uso detrás de un Tailscale
Funnel, con auth por Bearer token. Ver [HTTP_STREAMABLE.md](HTTP_STREAMABLE.md).

```bash
npm run build
MCP_HTTP_TOKEN="$(openssl rand -hex 32)" npm run serve:http
# http://127.0.0.1:8080/mcp  (+ /healthz)
```

(Próximamente rename a bashun-commander oficial)

---

Este es un fork limpio hecho para vos. Disfrutá.