#!/usr/bin/env node
/**
 * Servidor MCP sobre Streamable HTTP (spec 2025-03-26).
 *
 * Expone las tools de ./server.js (vía createMcpServer(), una instancia por
 * sesión) a través de un único endpoint HTTP (`POST` + `GET` + `DELETE /mcp`)
 * en lugar de stdio. Pensado para correr en localhost detrás de un Tailscale
 * Funnel; la seguridad la aporta un token Bearer (MCP_HTTP_TOKEN).
 *
 * Importante: el transporte Streamable HTTP del SDK es de UNA SOLA sesión por
 * instancia (un DELETE lo cierra de forma permanente). Por eso acá se crea un
 * par {Server, Transport} por cada Mcp-Session-Id y se rutea por header. Un
 * singleton compartido moriría con el primer DELETE.
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
 *   MCP_HTTP_MAX_SESSIONS     Máximo de sesiones concurrentes (default: 20)
 *   MCP_HTTP_BODY_LIMIT       Límite del body JSON (default: 10mb)
 *   MCP_HTTP_ALLOWED_HOSTS    Hosts extra permitidos, coma-separados (ej: tu-nodo.ts.net)
 *   MCP_HTTP_ALLOWED_ORIGINS  Origins de navegador permitidos, coma-separados (default: ninguno chequeado)
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, flushDeferredMessages } from './server.js';
import { configManager } from './config-manager.js';
import { featureFlagManager } from './utils/feature-flags.js';
import { logToStderr, logger } from './utils/logger.js';
import { ensureChromeAvailable } from './tools/pdf/markdown.js';
import { VERSION } from './version.js';

const PORT = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const MCP_PATH = process.env.MCP_HTTP_PATH || '/mcp';
const BODY_LIMIT = process.env.MCP_HTTP_BODY_LIMIT || '10mb';
const MAX_SESSIONS = parseInt(process.env.MCP_HTTP_MAX_SESSIONS || '20', 10);
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

function jsonRpcError(res: express.Response, httpStatus: number, code: number, message: string): void {
    res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function isInitBody(body: unknown): boolean {
    if (isInitializeRequest(body)) return true;
    return Array.isArray(body) && body.length === 1 && isInitializeRequest(body[0]);
}

interface Session {
    server: Server;
    transport: StreamableHTTPServerTransport;
}

async function runHttpServer(): Promise<void> {
    try {
        try {
            logToStderr('info', 'Loading configuration...');
            await configManager.loadConfig();
            logToStderr('info', 'Configuration loaded successfully');
            await featureFlagManager.initialize();
            flushDeferredMessages();
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

        const sessions = new Map<string, Session>();

        async function closeSession(sessionId: string): Promise<void> {
            const pair = sessions.get(sessionId);
            if (!pair) return;
            sessions.delete(sessionId);
            try {
                await pair.transport.close();
            } catch (error) {
                logger.error(`Error closing session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            }
            logger.info(`MCP HTTP session closed: ${sessionId} (${sessions.size} activas)`);
        }

        function makeTransport(): StreamableHTTPServerTransport {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableDnsRebindingProtection: true,
                allowedHosts: [...allowedHosts],
                ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
                onsessioninitialized: (sessionId) => {
                    const pair = pendingPairs.get(transport);
                    pendingPairs.delete(transport);
                    if (pair) {
                        sessions.set(sessionId, pair);
                        logger.info(`MCP HTTP session initialized: ${sessionId} (${sessions.size} activas)`);
                    }
                },
                onsessionclosed: (sessionId) => {
                    void closeSession(sessionId);
                },
            });
            transport.onerror = (error) => {
                logger.error(`MCP HTTP transport error: ${error.message}`);
            };
            return transport;
        }

        // Transportes recién creados cuyo sessionId aún no se conoce (se asigna
        // al procesar el initialize). Se mueven a `sessions` en onsessioninitialized.
        const pendingPairs = new Map<StreamableHTTPServerTransport, Session>();

        async function createSession(): Promise<StreamableHTTPServerTransport> {
            const mcpServer = createMcpServer();
            const transport = makeTransport();
            pendingPairs.set(transport, { server: mcpServer, transport });
            try {
                await mcpServer.connect(transport);
            } catch (error) {
                pendingPairs.delete(transport);
                throw error;
            }
            return transport;
        }

        // Igual que en modo stdio: pre-chequeo de Chrome para la tool write_pdf.
        ensureChromeAvailable();

        const app = express();
        app.use(express.json({ limit: BODY_LIMIT }));
        // No exponer fingerprint innecesario.
        app.disable('x-powered-by');

        // Healthcheck abierto (para el Funnel / uptime-kuma). No expone nada sensible.
        app.get('/healthz', (_req, res) => {
            res.json({ status: 'ok', name: 'desktop-commander', version: VERSION, transport: 'streamable-http', sessions: sessions.size });
        });

        // Auth: todo lo que cuelga de /mcp exige Bearer token.
        const requireToken: express.RequestHandler = (req, res, next) => {
            if (!hasValidToken(req)) {
                res.status(401).json({ error: 'unauthorized' });
                return;
            }
            next();
        };

        const forward = (transport: StreamableHTTPServerTransport, req: express.Request, res: express.Response, body?: unknown): void => {
            transport.handleRequest(req, res, body).catch((error) => {
                logger.error(`Error handling MCP request: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    jsonRpcError(res, 500, -32603, 'Internal server error');
                }
            });
        };

        function sessionIdOf(req: express.Request): string | undefined {
            const sid = req.headers['mcp-session-id'];
            return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
        }

        app.post(MCP_PATH, requireToken, (req, res) => {
            const sid = sessionIdOf(req);
            if (sid !== undefined) {
                const pair = sessions.get(sid);
                if (!pair) {
                    jsonRpcError(res, 404, -32001, 'Session not found');
                    return;
                }
                forward(pair.transport, req, res, req.body);
                return;
            }
            if (!isInitBody(req.body)) {
                jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
                return;
            }
            if (sessions.size + pendingPairs.size >= MAX_SESSIONS) {
                jsonRpcError(res, 503, -32000, 'Server busy: too many sessions');
                return;
            }
            createSession()
                .then((transport) => forward(transport, req, res, req.body))
                .catch((error) => {
                    logger.error(`Error creating session: ${error instanceof Error ? error.message : String(error)}`);
                    if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
                });
        });

        const requireSession = (req: express.Request, res: express.Response): Session | null => {
            const sid = sessionIdOf(req);
            if (sid === undefined) {
                jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
                return null;
            }
            const pair = sessions.get(sid);
            if (!pair) {
                jsonRpcError(res, 404, -32001, 'Session not found');
                return null;
            }
            return pair;
        };

        // GET sin body: stream standalone del servidor hacia el cliente.
        app.get(MCP_PATH, requireToken, (req, res) => {
            const pair = requireSession(req, res);
            if (!pair) return;
            forward(pair.transport, req, res);
        });

        // DELETE cierra la sesión (el transporte se cierra solo; onsessionclosed limpia el mapa).
        app.delete(MCP_PATH, requireToken, (req, res) => {
            const pair = requireSession(req, res);
            if (!pair) return;
            forward(pair.transport, req, res);
        });

        const httpServer = app.listen(PORT, HOST, () => {
            logToStderr('info', `MCP Streamable HTTP (stateful, 1 Server por sesion, max ${MAX_SESSIONS}) en http://${HOST}:${PORT}${MCP_PATH}`);
            logToStderr('info', `Healthcheck en http://${HOST}:${PORT}/healthz`);
            if (NO_AUTH) logToStderr('warning', 'SIN autenticación (MCP_HTTP_NO_AUTH=1)');
        });

        const shutdown = (signal: string): void => {
            logToStderr('info', `${signal} received, closing MCP HTTP server...`);
            httpServer.close();
            void Promise.all([...sessions.keys()].map((id) => closeSession(id))).finally(() => process.exit(0));
            setTimeout(() => process.exit(0), 5000).unref();
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (error) {
        failFast(`FATAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
}

void runHttpServer();
