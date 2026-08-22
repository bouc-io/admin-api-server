import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';
import { encrypt, decrypt } from '../services/encryptionService';

const log = createComponentLogger('mcp-servers-controller');

/**
 * Public (admin-UI) shape. Returns the decrypted bearer token so the edit form
 * can pre-fill it (same trade-off as sanitizeProvider's api_key); `auth_token_set`
 * signals whether one is stored.
 */
function sanitizeServer(s: {
    id: string;
    name: string;
    url: string;
    transport: string;
    auth_token_enc: string | null;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
    created_by: string | null;
}) {
    const { auth_token_enc, ...rest } = s;
    let auth_token: string | null = null;
    if (auth_token_enc) {
        try { auth_token = decrypt(auth_token_enc); } catch { auth_token = null; }
    }
    return { ...rest, auth_token_set: auth_token_enc !== null, auth_token };
}

/** GET /v1/admin/mcp-servers — list all configured MCP servers (global infra config). */
export const listMcpServers = async (_req: Request, res: Response) => {
    try {
        const servers = await prisma.mcpServer.findMany({ orderBy: { created_at: 'asc' } });
        res.json({ servers: servers.map(sanitizeServer) });
    } catch (error) {
        log.error({ err: error }, 'Failed to list MCP servers');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list MCP servers' } });
    }
};

/** POST /v1/admin/mcp-servers — register a new MCP server. */
export const createMcpServer = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const { name, url, transport, auth_token, enabled } = req.body;
    if (!name || !url) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and url are required' } });
    }

    try {
        const record = await prisma.mcpServer.create({
            data: {
                name,
                url,
                transport: transport ?? 'http',
                auth_token_enc: auth_token?.trim() ? encrypt(auth_token.trim()) : null,
                enabled: typeof enabled === 'boolean' ? enabled : true,
                created_by: ctx.userId,
            },
        });
        log.info({ id: record.id, userId: ctx.userId }, 'MCP server created');
        res.status(201).json(sanitizeServer(record));
    } catch (error) {
        if (isUniqueViolation(error)) {
            return res.status(409).json({ error: { code: 'CONFLICT', message: 'An MCP server with that name already exists' } });
        }
        log.error({ err: error }, 'Failed to create MCP server');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create MCP server' } });
    }
};

/** PUT /v1/admin/mcp-servers/:id — update an MCP server. */
export const updateMcpServer = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);
    const { name, url, transport, auth_token, enabled } = req.body;

    try {
        const existing = await prisma.mcpServer.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } });
        }

        const record = await prisma.mcpServer.update({
            where: { id },
            data: {
                ...(name !== undefined && { name }),
                ...(url !== undefined && { url }),
                ...(transport !== undefined && { transport }),
                // Only overwrite the token when a non-empty value is provided;
                // an empty string means "keep existing token" (field left blank).
                ...(auth_token !== undefined && auth_token.trim() !== '' && {
                    auth_token_enc: encrypt(auth_token.trim()),
                }),
                ...(typeof enabled === 'boolean' && { enabled }),
            },
        });
        log.info({ id, userId: ctx.userId }, 'MCP server updated');
        res.json(sanitizeServer(record));
    } catch (error) {
        if (isUniqueViolation(error)) {
            return res.status(409).json({ error: { code: 'CONFLICT', message: 'An MCP server with that name already exists' } });
        }
        log.error({ err: error, id }, 'Failed to update MCP server');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update MCP server' } });
    }
};

/** DELETE /v1/admin/mcp-servers/:id — remove an MCP server. */
export const deleteMcpServer = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);
    try {
        const existing = await prisma.mcpServer.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } });
        }
        await prisma.mcpServer.delete({ where: { id } });
        log.info({ id, userId: ctx.userId }, 'MCP server deleted');
        res.status(204).send();
    } catch (error) {
        log.error({ err: error, id }, 'Failed to delete MCP server');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete MCP server' } });
    }
};

/**
 * GET /v1/config/mcp-servers
 * Internal service-to-service endpoint consumed by agent-api-server at runtime.
 * Returns enabled servers with the DECRYPTED bearer token so the agent can
 * authenticate to the remote MCP server.
 */
export const getMcpServersConfig = async (_req: Request, res: Response) => {
    try {
        const servers = await prisma.mcpServer.findMany({ where: { enabled: true } });
        const result = servers.map((s) => {
            let auth_token: string | null = null;
            if (s.auth_token_enc) {
                try {
                    auth_token = decrypt(s.auth_token_enc);
                } catch (err) {
                    log.warn({ err, id: s.id }, 'Failed to decrypt MCP auth token');
                }
            }
            return {
                id: s.id,
                name: s.name,
                url: s.url,
                transport: s.transport,
                auth_token,
            };
        });
        res.json({ servers: result });
    } catch (error) {
        log.error({ err: error }, 'Failed to fetch MCP server config');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch MCP server config' } });
    }
};

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
    );
}
