import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest, isBoucRole, UserContext } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';

const log = createComponentLogger('instructions-controller');

/**
 * Returns true if the requesting user is allowed to mutate the given instruction.
 * bouc_* staff can always mutate (global or any org).
 * org_admin can only mutate instructions that belong to their org (not global ones).
 */
function canMutateInstruction(ctx: UserContext, instructionOrgId: string | null): boolean {
    if (isBoucRole(ctx.roles)) {
        if (!ctx.activeOrgId) return true;                  // global view: unrestricted
        if (instructionOrgId === null) return true;         // global instructions: bouc_* can always edit regardless of active org
        return instructionOrgId === ctx.activeOrgId;        // org-specific: must match active org selection
    }
    // org_admin: can only mutate their own org's instructions, not global ones
    return instructionOrgId !== null && instructionOrgId === ctx.orgId;
}

/**
 * GET /v1/admin/instructions
 * List all instructions (all statuses), ordered by priority then created_at
 */
export const listInstructions = async (req: Request, res: Response) => {
    try {
        const ctx = getUserContextFromRequest(req);
        // bouc_* with no active org selected → global view (all instructions)
        // bouc_* with active org, or org_admin → scoped to global + their org
        const where = ctx?.activeOrgId != null
            ? { OR: [{ org_id: null }, { org_id: ctx.activeOrgId }] }
            : {};
        const instructions = await prisma.llmInstruction.findMany({
            where,
            orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
        });
        res.json({ instructions });
    } catch (error) {
        log.error({ err: error }, 'Failed to list instructions');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list instructions' } });
    }
};

/**
 * POST /v1/admin/instructions
 * Create a new instruction
 */
export const createInstruction = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const { title, content, priority, is_active } = req.body;
    if (!title || !content) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title and content are required' } });
    }

    // bouc_* may pass explicit org_id in body or use activeOrgId; org_admin is pinned to their org
    const rawOrgId = isBoucRole(ctx.roles)
        ? (req.body.org_id ?? ctx.activeOrgId ?? null)
        : ctx.orgId;

    try {
        // Validate that the resolved org_id actually exists in the organizations table.
        // If it doesn't (e.g. Keycloak JWT org UUID not yet registered in the admin DB),
        // fall back to global (null) rather than blowing up with an FK violation.
        let orgIdForCreate: string | null = rawOrgId;
        if (rawOrgId) {
            const orgExists = await prisma.organization.findUnique({ where: { id: rawOrgId }, select: { id: true } });
            if (!orgExists) {
                log.warn({ rawOrgId, userId: ctx.userId }, 'org_id not found in organizations table — creating instruction as global');
                orgIdForCreate = null;
            }
        }

        const instruction = await prisma.llmInstruction.create({
            data: {
                title,
                content,
                priority: typeof priority === 'number' ? priority : 0,
                is_active: typeof is_active === 'boolean' ? is_active : true,
                created_by: ctx.userId,
                ...(orgIdForCreate && { org_id: orgIdForCreate }),
            },
        });
        log.info({ id: instruction.id, userId: ctx.userId }, 'Instruction created');
        res.status(201).json(instruction);
    } catch (error) {
        log.error({ err: error }, 'Failed to create instruction');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create instruction' } });
    }
};

/**
 * PUT /v1/admin/instructions/:id
 * Update an instruction
 */
export const updateInstruction = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);
    const { title, content, priority, is_active } = req.body;

    try {
        const existing = await prisma.llmInstruction.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Instruction not found' } });
        }

        if (!canMutateInstruction(ctx, existing.org_id)) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot modify instructions outside your organization' } });
        }

        const instruction = await prisma.llmInstruction.update({
            where: { id },
            data: {
                ...(title !== undefined && { title }),
                ...(content !== undefined && { content }),
                ...(typeof priority === 'number' && { priority }),
                ...(typeof is_active === 'boolean' && { is_active }),
            },
        });
        log.info({ id, userId: ctx.userId }, 'Instruction updated');
        res.json(instruction);
    } catch (error) {
        log.error({ err: error, id }, 'Failed to update instruction');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update instruction' } });
    }
};

/**
 * DELETE /v1/admin/instructions/:id
 * Delete an instruction
 */
export const deleteInstruction = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);

    try {
        const existing = await prisma.llmInstruction.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Instruction not found' } });
        }

        if (!canMutateInstruction(ctx, existing.org_id)) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot delete instructions outside your organization' } });
        }

        await prisma.llmInstruction.delete({ where: { id } });
        log.info({ id, userId: ctx.userId }, 'Instruction deleted');
        res.status(204).send();
    } catch (error) {
        log.error({ err: error, id }, 'Failed to delete instruction');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete instruction' } });
    }
};

/**
 * PATCH /v1/admin/instructions/:id/toggle
 * Toggle is_active status
 */
export const toggleInstruction = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);

    try {
        const existing = await prisma.llmInstruction.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Instruction not found' } });
        }

        if (!canMutateInstruction(ctx, existing.org_id)) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot toggle instructions outside your organization' } });
        }

        const instruction = await prisma.llmInstruction.update({
            where: { id },
            data: { is_active: !existing.is_active },
        });
        log.info({ id, userId: ctx.userId, is_active: instruction.is_active }, 'Instruction toggled');
        res.json(instruction);
    } catch (error) {
        log.error({ err: error, id }, 'Failed to toggle instruction');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to toggle instruction' } });
    }
};

/**
 * GET /v1/config/instructions
 * Internal service endpoint: returns active global instructions (org_id=null) plus org-level
 * instructions for the caller's org (if any). Used by agent-api-server and chatbot-api-server.
 */
export const listActiveInstructions = async (req: Request, res: Response) => {
    try {
        const ctx = getUserContextFromRequest(req);
        const orgId = ctx?.orgId ?? null;

        const instructions = await prisma.llmInstruction.findMany({
            where: {
                is_active: true,
                OR: [
                    { org_id: null },
                    ...(orgId ? [{ org_id: orgId }] : []),
                ],
            },
            orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
            select: { id: true, title: true, content: true, priority: true },
        });
        res.json({ instructions });
    } catch (error) {
        log.error({ err: error }, 'Failed to fetch active instructions');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch instructions' } });
    }
};
