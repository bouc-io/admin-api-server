import { Request, Response } from 'express';
import axios from 'axios';
import https from 'https';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest, isBoucRole } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';
import { encrypt, decrypt } from '../services/encryptionService';

const log = createComponentLogger('llm-providers-controller');

const allowSelfSigned = process.env.ALLOW_SELF_SIGNED_CERTS === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

/** Decrypt stored key and include it in the response alongside api_key_set.
 *  The admin UI needs the plaintext key so it can pre-fill the edit form and
 *  let users verify the value with the eye-icon toggle. */
function sanitizeProvider(p: {
    id: string;
    org_id: string | null;
    name: string;
    provider: string;
    api_endpoint: string;
    api_key_enc: string | null;
    models: string[];
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
    created_by: string | null;
}) {
    const { api_key_enc, ...rest } = p;
    let api_key: string | null = null;
    if (api_key_enc) {
        try { api_key = decrypt(api_key_enc); } catch { api_key = null; }
    }
    return { ...rest, api_key_set: api_key_enc !== null, api_key };
}

/**
 * Whether the calling user is allowed to create/update/delete the given provider.
 *
 * bouc_* with NO active org selected → global admin view → unrestricted.
 * bouc_* with an active org selected → org-scoped view → only that org's providers.
 * org_admin_enterprise → only their own org's providers (providerOrgId must match ctx.orgId).
 */
function canMutateProvider(
    ctx: { roles: string[]; orgId: string | null; activeOrgId: string | null },
    providerOrgId: string | null
): boolean {
    if (isBoucRole(ctx.roles)) {
        if (!ctx.activeOrgId) return true;          // global view: unrestricted
        return providerOrgId === ctx.activeOrgId;    // org-scoped view: own org only
    }
    return providerOrgId !== null && providerOrgId === ctx.orgId;
}

/**
 * GET /v1/admin/llm-providers
 *
 * bouc_* with no active org → global view (all providers).
 * bouc_* with active org selected → that org's providers only.
 * org_admin_enterprise → their own org's providers only.
 */
export const listProviders = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    try {
        let where: Record<string, unknown> = {};
        if (ctx) {
            if (isBoucRole(ctx.roles)) {
                if (ctx.activeOrgId) where = { org_id: ctx.activeOrgId };
                // else: no filter → global view
            } else {
                where = { org_id: ctx.orgId };
            }
        }

        const providers = await prisma.llmProvider.findMany({
            where,
            orderBy: { created_at: 'asc' },
        });
        res.json({ providers: providers.map(sanitizeProvider) });
    } catch (error) {
        log.error({ err: error }, 'Failed to list providers');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list providers' } });
    }
};

/**
 * POST /v1/admin/llm-providers
 * bouc_* can pass an explicit org_id or default to activeOrgId.
 * org_admin_enterprise is always pinned to their own org.
 */
export const createProvider = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const { name, provider, api_endpoint, api_key, models, is_active, org_id: bodyOrgId } = req.body;
    const endpointRequired = provider !== 'boucio';
    if (!name || !provider || (endpointRequired && !api_endpoint)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and provider are required; api_endpoint is required for non-boucio providers' } });
    }

    // Resolve which org this provider belongs to.
    // bouc_* may pass an explicit org_id; falls back to their activeOrgId (or null = global).
    // org_admin_enterprise is always pinned to their JWT orgId.
    const orgIdForCreate = isBoucRole(ctx.roles)
        ? (bodyOrgId ?? ctx.activeOrgId ?? null)
        : ctx.orgId;

    try {
        const record = await prisma.llmProvider.create({
            data: {
                org_id: orgIdForCreate,
                name,
                provider,
                api_endpoint,
                api_key_enc: api_key?.trim() ? encrypt(api_key.trim()) : null,
                models: Array.isArray(models) ? models : [],
                is_active: typeof is_active === 'boolean' ? is_active : false,
                created_by: ctx.userId,
            },
        });
        log.info({ id: record.id, userId: ctx.userId, orgId: orgIdForCreate }, 'Provider created');
        res.status(201).json(sanitizeProvider(record));
    } catch (error) {
        log.error({ err: error }, 'Failed to create provider');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create provider' } });
    }
};

/**
 * PUT /v1/admin/llm-providers/:id
 * bouc_* with org selected can only update that org's providers.
 * org_admin_enterprise can only update their own org's providers.
 */
export const updateProvider = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);
    const { name, provider, api_endpoint, api_key, models, is_active } = req.body;

    try {
        const existing = await prisma.llmProvider.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Provider not found' } });
        }
        if (!canMutateProvider(ctx, existing.org_id)) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only modify providers in your active organization' } });
        }

        const record = await prisma.llmProvider.update({
            where: { id },
            data: {
                ...(name !== undefined && { name }),
                ...(provider !== undefined && { provider }),
                ...(api_endpoint !== undefined && { api_endpoint }),
                // Only update the key when a non-empty value is explicitly provided.
                // An empty string means "keep existing key" (field left blank in the edit form).
                // Also trim to prevent trailing-whitespace issues from copy-paste.
                ...(api_key !== undefined && api_key.trim() !== '' && { api_key_enc: encrypt(api_key.trim()) }),
                ...(Array.isArray(models) && { models }),
                ...(typeof is_active === 'boolean' && { is_active }),
            },
        });
        log.info({ id, userId: ctx.userId }, 'Provider updated');
        res.json(sanitizeProvider(record));
    } catch (error) {
        log.error({ err: error, id }, 'Failed to update provider');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update provider' } });
    }
};

/**
 * DELETE /v1/admin/llm-providers/:id
 * bouc_* with org selected can only delete that org's providers.
 * org_admin_enterprise can only delete their own org's providers.
 */
export const deleteProvider = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);

    try {
        const existing = await prisma.llmProvider.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Provider not found' } });
        }
        if (!canMutateProvider(ctx, existing.org_id)) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only delete providers in your active organization' } });
        }

        await prisma.llmProvider.delete({ where: { id } });
        log.info({ id, userId: ctx.userId }, 'Provider deleted');
        res.status(204).send();
    } catch (error) {
        log.error({ err: error, id }, 'Failed to delete provider');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete provider' } });
    }
};

/**
 * POST /v1/admin/llm-providers/:id/test
 * Probe the provider's API endpoint with a minimal authenticated request.
 * bouc_* with org selected can only test that org's providers.
 */
export const testProvider = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);

    try {
        const existing = await prisma.llmProvider.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Provider not found' } });
        }
        if (!canMutateProvider(ctx, existing.org_id)) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only test providers in your active organization' } });
        }

        const apiKey = existing.api_key_enc ? decrypt(existing.api_key_enc) : null;
        const base = existing.api_endpoint.replace(/\/$/, '');
        let start = Date.now();

        let probeUrl: string;
        let probeMethod: 'get' | 'post' = 'get';
        let probeBody: Record<string, unknown> | undefined;
        let headers: Record<string, string> = {};

        switch (existing.provider) {
            case 'anthropic':
                // Anthropic /v1/models returns 403 without an org; use a minimal chat probe instead.
                // max_tokens must be ≥1024 for Claude 4+ models which have extended thinking
                // enabled by default — lower values cause a 400 invalid_request_error.
                probeUrl = `${base}/v1/messages`;
                probeMethod = 'post';
                probeBody = {
                    model: existing.models[0] ?? 'claude-3-haiku-20240307',
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1024,
                };
                if (apiKey) headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
                break;
            case 'boucio': {
                // Use the server-side OLLAMA_URL env var — the stored api_endpoint may be empty for boucio.
                const ollamaBase = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
                probeUrl = `${ollamaBase}/api/tags`;
                // No Authorization header — cluster OAuth is handled internally by the AI services, not here.
                break;
            }
            case 'ollama':
                probeUrl = `${base}/api/tags`;
                break;
            default:
                // openai, azure, google, custom
                probeUrl = `${base}/models`;
                if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        }

        if (probeMethod === 'post') {
            await axios.post(probeUrl, probeBody, { headers, timeout: 5000, httpsAgent });
        } else {
            await axios.get(probeUrl, { headers, timeout: 5000, httpsAgent });
        }

        const latency_ms = Date.now() - start;
        log.info({ id, latency_ms }, 'Provider test successful');
        res.json({ success: true, latency_ms });
    } catch (error: any) {
        // Prefer the provider's actual error body (e.g. Anthropic/OpenAI error JSON)
        // over the generic Axios "Request failed with status code N" string.
        const responseBody = error?.response?.data;
        const providerMessage =
            responseBody?.error?.message ||   // Anthropic: { error: { type, message } }
            responseBody?.message ||           // OpenAI: { error: { message } } → unwrapped above; also plain { message }
            responseBody?.error ||             // plain string error field
            null;
        const message = providerMessage || error?.message || 'Unknown error';
        log.warn({ id, err: error?.message, status: error?.response?.status, providerError: responseBody }, 'Provider test failed');
        res.json({ success: false, latency_ms: null, error: message });
    }
};
