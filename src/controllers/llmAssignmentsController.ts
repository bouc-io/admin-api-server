import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest, isBoucRole } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';
import { decrypt } from '../services/encryptionService';

const log = createComponentLogger('llm-assignments-controller');

const VALID_USE_CASES = ['chatbot', 'agent_plan', 'agent_execution', 'memory_distiller', 'memory_embedding'] as const;
type UseCase = (typeof VALID_USE_CASES)[number];

/**
 * GET /v1/admin/llm-assignments
 * bouc_* staff see all assignments (all orgs).
 * org_admin_enterprise sees only their own org's assignments.
 */
export const listAssignments = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    try {
        let where: Record<string, unknown> = {};
        if (ctx) {
            if (isBoucRole(ctx.roles)) {
                if (ctx.activeOrgId) where = { org_id: ctx.activeOrgId };
                // else: no filter → global view (all assignments)
            } else {
                where = { org_id: ctx.orgId }; // org_admin_enterprise: own org only
            }
        }

        const assignments = await prisma.llmAssignment.findMany({
            where,
            include: {
                provider: {
                    select: { id: true, name: true, provider: true, api_endpoint: true, models: true },
                },
            },
            orderBy: [{ org_id: 'asc' }, { use_case: 'asc' }],
        });
        res.json({ assignments });
    } catch (error) {
        log.error({ err: error }, 'Failed to list assignments');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list assignments' } });
    }
};

/**
 * PUT /v1/admin/llm-assignments/:useCase
 * Update (or create) the assignment for a specific use case and org.
 *
 * bouc_* can pass an explicit org_id in the body; otherwise defaults to activeOrgId.
 * org_admin_enterprise is always pinned to their JWT orgId.
 *
 * NOTE: Prisma upsert({ where: { use_case } }) no longer works after removing @unique
 * from use_case. We use findFirst + update/create instead.
 */
export const updateAssignment = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const useCase = String(req.params.useCase);
    if (!VALID_USE_CASES.includes(useCase as UseCase)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `useCase must be one of: ${VALID_USE_CASES.join(', ')}` },
        });
    }

    const { providerId, model, enableReasoning, org_id: bodyOrgId } = req.body;

    // Resolve which org this assignment belongs to.
    // bouc_* may pass an explicit org_id in the body; falls back to activeOrgId.
    // org_admin_enterprise is always pinned to their JWT orgId.
    const orgIdForWrite: string | null = isBoucRole(ctx.roles)
        ? (bodyOrgId ?? ctx.activeOrgId ?? null)
        : ctx.orgId;

    try {
        // Validate provider exists if provided
        if (providerId) {
            const provider = await prisma.llmProvider.findUnique({ where: { id: providerId } });
            if (!provider) {
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provider not found' } });
            }
        }

        const data = {
            provider_id: providerId !== undefined ? (providerId || null) : null,
            model: model !== undefined ? (model || null) : null,
            enable_reasoning: typeof enableReasoning === 'boolean' ? enableReasoning : false,
        };

        // findFirst + update/create pattern (required because uniqueness on
        // use_case+org_id is enforced by partial DB indexes, not Prisma @@unique)
        const existing = await prisma.llmAssignment.findFirst({
            where: { use_case: useCase, org_id: orgIdForWrite },
        });

        let assignment;
        if (existing) {
            assignment = await prisma.llmAssignment.update({
                where: { id: existing.id },
                data: {
                    ...(providerId !== undefined && { provider_id: providerId || null }),
                    ...(model !== undefined && { model: model || null }),
                    ...(typeof enableReasoning === 'boolean' && { enable_reasoning: enableReasoning }),
                },
                include: {
                    provider: {
                        select: { id: true, name: true, provider: true, api_endpoint: true, models: true },
                    },
                },
            });
        } else {
            assignment = await prisma.llmAssignment.create({
                data: { use_case: useCase, org_id: orgIdForWrite, ...data },
                include: {
                    provider: {
                        select: { id: true, name: true, provider: true, api_endpoint: true, models: true },
                    },
                },
            });
        }

        log.info({ useCase, orgId: orgIdForWrite, userId: ctx.userId }, 'Assignment updated');
        res.json(assignment);
    } catch (error) {
        log.error({ err: error, useCase }, 'Failed to update assignment');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update assignment' } });
    }
};

/**
 * GET /v1/config/llm-assignment/:useCase
 * Internal service-to-service endpoint. Returns endpoint + model + decrypted API key.
 *
 * Resolution chain (uses JWT orgId, NOT the admin X-Active-Org override):
 *   1. Org-specific assignment for ctx.orgId  → wins if present
 *   2. Global assignment (org_id IS NULL)     → fallback
 *   3. 404                                    → caller falls back to env-var Ollama
 */
export const getAssignmentConfig = async (req: Request, res: Response) => {
    const useCase = String(req.params.useCase);
    const ctx = getUserContextFromRequest(req);
    const orgId = ctx?.orgId ?? null;

    try {
        let assignment = null;

        // Step 1: try org-specific assignment
        if (orgId) {
            assignment = await prisma.llmAssignment.findFirst({
                where: { use_case: useCase, org_id: orgId },
                include: { provider: true },
            });
        }

        // Step 2: fall back to global assignment
        if (!assignment) {
            assignment = await prisma.llmAssignment.findFirst({
                where: { use_case: useCase, org_id: null },
                include: { provider: true },
            });
        }

        if (!assignment) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No assignment found for this use case' } });
        }

        const provider = assignment.provider;
        let apiKey: string | null = null;
        if (provider?.api_key_enc) {
            try {
                apiKey = decrypt(provider.api_key_enc);
            } catch (err) {
                log.warn({ err, useCase }, 'Failed to decrypt API key for assignment config');
            }
        }

        res.json({
            use_case: assignment.use_case,
            org_id: assignment.org_id,
            model: assignment.model,
            enable_reasoning: assignment.enable_reasoning,
            provider: provider
                ? {
                    id: provider.id,
                    name: provider.name,
                    provider: provider.provider,
                    api_endpoint: provider.api_endpoint,
                    api_key: apiKey,
                  }
                : null,
        });
    } catch (error) {
        log.error({ err: error, useCase }, 'Failed to fetch assignment config');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch assignment config' } });
    }
};
