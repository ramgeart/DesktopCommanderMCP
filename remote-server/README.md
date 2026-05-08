# Bashun Remote Server

Servidor intermedio compatible con `remote-device` de bashun-commander.

## Cómo usarlo

1. Copia `.env.example` a `.env` y completá con tus datos de Supabase.
2. `npm install`
3. `npm start`

Apuntá tu DNS `mcp.zkarmor.com` a este servidor.

Una vez corriendo, el `remote-device` usará `MCP_SERVER_URL=https://mcp.zkarmor.com`

Compatible 100% con el flow de autorización original.