#!/usr/bin/env node
/**
 * Servidor MCP sobre Streamable HTTP (spec 2025-03-26).
 *
 * Expone EL MISMO `server` de ./server.js (todas las tools locales) a través
 * de un único endpoint HTTP (`POST` + `GET` + `DELETE /mcp`) en lugar de stdio.
 * Pensado para correr en localhost detrás de un Tailscale Funnel; la seguridad
 * la aporta un token Bearer (MCP_HTTP_TOKEN).
 *
 * Uso:
 *   npm run build
 *   MCP_HTTP_TOKEN=$(openssl rand -hex 32) node dist/http.js
 *
 * Variables de entorno (ver HTTP_STREAMABLE.md para el detalle):
 *   MCP_HTTP_TOKEN            Bearer token requerido (obligatorio salvo MCP_HTTP_NO_AUTH=1)
 *   MCP_HTTP_PORT             Puerto de escucha (default: 8080)
 *   MCP_HTTP_HOST             Interfaz de escucha (default: 127.0.0.1)
 *   MCP_HTTP_PATH             Ruta del endpoint MCP (default: /mcp)
 *   MCP_HTTP_STATELESS=1      Modo sin sesiones (default: con sesiones + Mcp-Session-Id)
 *   MCP_HTTP_BODY_LIMIT       Límite del body JSON (default: 10mb)
 *   MCP_HTTP_ALLOWED_HOSTS    Hosts extra permitidos, coma-separados (ej: tu-nodo.ts.net)
 *   MCP_HTTP_ALLOWED_ORIGINS  Origins de navegador permitidos, coma-separados (default: ninguno chequeado)
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { server } from './server.js';
import { configManager } from './config-manager.js';
import { featureFlagManager } from './utils/feature-flags.js';
import { logToStderr, logger } from './utils/logger.js';
import { ensureChromeAvailable } from './tools/pdf/markdown.js';
import { VERSION } from './version.js';

const PORT = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const MCP_PATH = process.env.MCP_HTTP_PATH || '/mcp';
const BODY_LIMIT = process.env.MCP_HTTP_BODY_LIMIT || '10mb';
const STATELESS = process.env.MCP_HTTP_STATELESS === '1';
const TOKEN = process.env.MCP_HTTP_TOKEN || '';
const NO_AUTH = process.env.MCP_HTTP_NO_AUTH === '1';

function parseList(value: string | undefined): string[] {
    return (value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function failFast(message: string): never {
    logger.error(message);
    process.exit(1);
}

if (!TOKEN && !NO_AUTH) {
    failFast(
        'MCP_HTTP_TOKEN no está definido. Generá uno con `openssl rand -hex 32` y exportalo. ' +
        'Solo para desarrollo local podés usar MCP_HTTP_NO_AUTH=1 (nunca detrás de un Funnel).'
    );
}
if (NO_AUTH) {
    logger.warning('MCP_HTTP_NO_AUTH=1: el endpoint /mcp queda SIN autenticación. No exponer a red.');
}

/** Comparación en tiempo constante para no filtrar el token por timing. */
function hasValidToken(req: express.Request): boolean {
    if (NO_AUTH) return true;
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(TOKEN);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function runHttpServer(): Promise<void> {
    try {
        try {
            logToStderr('info', 'Loading configuration...');
            await configManager.loadConfig();
            logToStderr('info', 'Configuration loaded successfully');
            await featureFlagManager.initialize();
        } catch (configError) {
            logToStderr('warning', `Continuing with in-memory configuration only: ${configError}`);
        }

        process.on('uncaughtException', (error) => {
            logger.error(`Uncaught exception: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
        process.on('unhandledRejection', (reason) => {
            logger.error(`Unhandled rejection: ${String(reason)}`);
            process.exit(1);
        });

        // Hosts permitidos para la protección anti DNS-rebinding del SDK.
        // El header Host DEBE matchear exacto: agregar el hostname del Funnel
        // (ej: mi-nodo.ts.net) vía MCP_HTTP_ALLOWED_HOSTS o todo POST/GET da 400.
        const allowedHosts = new Set<string>(['127.0.0.1', 'localhost', `${HOST}:${PORT}`]);
        if (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '0.0.0.0') {
            allowedHosts.add(`127.0.0.1:${PORT}`);
            allowedHosts.add(`localhost:${PORT}`);
        }
        for (const extra of parseList(process.env.MCP_HTTP_ALLOWED_HOSTS)) {
            allowedHosts.add(extra);
        }
        const allowedOrigins = parseList(process.env.MCP_HTTP_ALLOWED_ORIGINS);

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: STATELESS ? undefined : () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: [...allowedHosts],
            ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
            onsessioninitialized: (sessionId) => {
                logger.info(`MCP HTTP session initialized: ${sessionId}`);
            },
            onsessionclosed: (sessionId) => {
                logger.info(`MCP HTTP session closed: ${sessionId}`);
            },
        });
        transport.onerror = (error) => {
            logger.error(`MCP HTTP transport error: ${error.message}`);
        };

        await server.connect(transport);
        // Igual que en modo stdio: pre-chequeo de Chrome para la tool write_pdf.
        ensureChromeAvailable();

        const app = express();
        app.use(express.json({ limit: BODY_LIMIT }));
        // No exponer fingerprint innecesario.
        app.disable('x-powered-by');

        // Healthcheck abierto (para el Funnel / uptime-kuma). No expone nada sensible.
        app.get('/healthz', (_req, res) => {
            res.json({ status: 'ok', name: 'desktop-commander', version: VERSION, transport: 'streamable-http' });
        });

        // Auth: todo lo que cuelga de /mcp exige Bearer token.
        const requireToken: express.RequestHandler = (req, res, next) => {
            if (!hasValidToken(req)) {
                res.status(401).json({ error: 'unauthorized' });
                return;
            }
            next();
        };

        const handleMcp = (req: express.Request, res: express.Response): void => {
            transport.handleRequest(req, res, req.body).catch((error) => {
                logger.error(`Error handling MCP request: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: 'Internal server error' },
                        id: null,
                    });
                }
            });
        };

        app.post(MCP_PATH, requireToken, handleMcp);
        app.get(MCP_PATH, requireToken, handleMcp);
        app.delete(MCP_PATH, requireToken, handleMcp);

        const httpServer = app.listen(PORT, HOST, () => {
            logToStderr('info', `MCP Streamable HTTP (${STATELESS ? 'stateless' : 'stateful'}) en http://${HOST}:${PORT}${MCP_PATH}`);
            logToStderr('info', `Healthcheck en http://${HOST}:${PORT}/healthz`);
            if (NO_AUTH) logToStderr('warning', 'SIN autenticación (MCP_HTTP_NO_AUTH=1)');
        });

        const shutdown = async (signal: string): Promise<void> => {
            logToStderr('info', `${signal} received, closing MCP HTTP server...`);
            httpServer.close();
            try {
                await transport.close();
            } catch (error) {
                logger.error(`Error closing transport: ${error instanceof Error ? error.message : String(error)}`);
            }
            process.exit(0);
        };
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
    } catch (error) {
        failFast(`FATAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
}

void runHttpServer();
