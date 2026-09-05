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
const MAX_SESSIONS = parseInt(process.env.MCP_HTTP_MAX_SESSIONS || '50', 10);
// TTL de inactividad por sesión (default 5 min). Los clientes bien portados
// mandan DELETE al terminar, pero los scanners a veces no lo hacen y las
// sesiones filtradas agotarían MAX_SESSIONS (→ 503). 0 = sin expiración.
const SESSION_TTL_MS = parseInt(process.env.MCP_HTTP_SESSION_TTL_MS || '300000', 10);
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
    lastSeen: number;
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
                        pair.lastSeen = Date.now();
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

        // Limpieza de sesiones inactivas (scanners que nunca mandan DELETE).
        if (SESSION_TTL_MS > 0) {
            setInterval(() => {
                const now = Date.now();
                for (const [id, pair] of sessions) {
                    if (now - pair.lastSeen > SESSION_TTL_MS) {
                        logger.info(`MCP HTTP session expired by idle TTL: ${id}`);
                        void closeSession(id);
                    }
                }
            }, 60000).unref();
        }

        async function createSession(): Promise<StreamableHTTPServerTransport> {
            const mcpServer = createMcpServer();
            const transport = makeTransport();
            pendingPairs.set(transport, { server: mcpServer, transport, lastSeen: Date.now() });
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

        // Log de requests MCP (debug forense). MCP_HTTP_DEBUG=1. Nunca loguea
        // el Authorization header ni bodies completos (pueden traer datos).
        const DEBUG = process.env.MCP_HTTP_DEBUG === '1';
        if (DEBUG) {
            app.use(MCP_PATH, (req, _res, next) => {
                const body = req.body as unknown;
                const msg = Array.isArray(body)
                    ? `batch[${body.length}](${(body as Array<{ method?: unknown }>).map((m) => String(m?.method)).join(',')})`
                    : `method=${String((body as { method?: unknown } | null)?.method)} id=${String((body as { id?: unknown } | null)?.id)}`;
                const rpc = (body && typeof body === 'object' ? body : {}) as {
                    params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown }; name?: unknown };
                };
                const pv = rpc.params?.protocolVersion;
                const cn = rpc.params?.clientInfo?.name;
                // Para tools/call se loguea el nombre de la tool (no los argumentos).
                const tool = (body as { method?: unknown } | null)?.method === 'tools/call'
                    ? ` tool=${String(rpc.params?.name ?? '?')}` : '';
                logger.info(`MCP ${req.method} proto=${req.headers['mcp-protocol-version'] ?? '-'} sid=${req.headers['mcp-session-id'] ?? '-'} ${msg}${pv ? ` pv=${String(pv)}` : ''}${cn ? ` client=${String(cn)}` : ''}${tool} accept=${String(req.headers.accept ?? '-')} ua=${String(req.headers['user-agent'] ?? '-').slice(0, 80)}`);
                next();
            });
        }

        // El adaptador @hono/node-server del SDK pone Content-Length a todo body
        // string, incluido el SSE (text/event-stream). Un stream con Content-Length
        // es contradictorio y clientes estrictos (ej: el conector de OpenAI) lo
        // dan por conexión rota ("Connection failed" tras el auth). Se quita el
        // header en respuestas SSE para que Node use chunked (framing correcto).
        const stripSseContentLength: express.RequestHandler = (_req, res, next) => {
            const origWriteHead = res.writeHead.bind(res);
            res.writeHead = ((statusCode: number, ...args: unknown[]): unknown => {
                let headers: unknown;
                let headerIndex = -1;
                if (args.length === 2 && typeof args[1] === 'object' && args[1] !== null) {
                    headerIndex = 1;
                    headers = args[1];
                } else if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
                    headerIndex = 0;
                    headers = args[0];
                }
                if (headerIndex >= 0 && headers !== undefined) {
                    const entries: Array<[string, unknown]> = Array.isArray(headers)
                        ? (headers as Array<[string, unknown]>)
                        : Object.entries(headers as Record<string, unknown>);
                    const isSse = entries.some(([name, value]) =>
                        name.toLowerCase() === 'content-type' &&
                        String(value).includes('text/event-stream'));
                    if (isSse) {
                        if (Array.isArray(headers)) {
                            (args as unknown[])[headerIndex] = (headers as Array<[string, unknown]>)
                                .filter(([name]) => name.toLowerCase() !== 'content-length');
                        } else {
                            for (const name of Object.keys(headers as Record<string, unknown>)) {
                                if (name.toLowerCase() === 'content-length') {
                                    delete (headers as Record<string, unknown>)[name];
                                }
                            }
                        }
                    }
                }
                return (origWriteHead as (...a: unknown[]) => unknown)(statusCode, ...args);
            }) as typeof res.writeHead;
            next();
        };
        app.use(MCP_PATH, stripSseContentLength);

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
            // Marcar actividad (frena el TTL de inactividad).
            for (const pair of sessions.values()) {
                if (pair.transport === transport) {
                    pair.lastSeen = Date.now();
                    break;
                }
            }
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
