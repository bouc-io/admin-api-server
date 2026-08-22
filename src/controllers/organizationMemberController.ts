import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';
import { keycloakAdminClient } from '../services/keycloakAdminClient';

const log = createComponentLogger('org-member-controller');

/**
 * GET /v1/admin/organizations/:orgId/members
 * List all members of an organization
 */
export const listMembers = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const orgId = String(req.params.orgId);

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId } });
        if (!org) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }

        const members = await prisma.organizationMember.findMany({
            where: { org_id: orgId },
            orderBy: { joined_at: 'desc' },
        });
        res.json({ members });
    } catch (error) {
        log.error({ err: error, orgId }, 'Failed to list members');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list members' } });
    }
};

/**
 * POST /v1/admin/organizations/:orgId/members
 * Add a member to an organization
 */
export const addMember = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const orgId = String(req.params.orgId);
    const { user_id, email, role } = req.body;

    const resolvedUserId = user_id || email;
    if (!resolvedUserId) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'user_id or email is required' } });
    }

    const validRoles = ['owner', 'admin', 'member'];
    if (role && !validRoles.includes(role)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `role must be one of: ${validRoles.join(', ')}` },
        });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId } });
        if (!org) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }

        const member = await prisma.organizationMember.create({
            data: {
                org_id: orgId,
                user_id: resolvedUserId,
                role: role || 'member',
            },
        });
        log.info({ orgId, user_id, role: member.role, userId: ctx.userId }, 'Member added');

        // Update org_id user attribute in Keycloak so the user's next JWT reflects the new org.
        // This is best-effort — a Keycloak outage should not prevent the DB write from succeeding.
        try {
            await keycloakAdminClient.setUserOrgAttribute(resolvedUserId, orgId);
        } catch (kcErr) {
            log.warn({ err: kcErr, user_id: resolvedUserId, orgId }, 'Failed to update org_id in Keycloak — user attribute will not reflect new org until next SSO login or manual update');
        }

        res.status(201).json(member);
    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: { code: 'CONFLICT', message: 'User is already a member of this organization' } });
        }
        log.error({ err: error, orgId }, 'Failed to add member');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add member' } });
    }
};

/**
 * PUT /v1/admin/organizations/:orgId/members/:id
 * Update a member's role
 */
export const updateMember = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const orgId = String(req.params.orgId);
    const id = String(req.params.id);
    const { role } = req.body;

    const validRoles = ['owner', 'admin', 'member'];
    if (!role || !validRoles.includes(role)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `role must be one of: ${validRoles.join(', ')}` },
        });
    }

    try {
        const existing = await prisma.organizationMember.findFirst({
            where: { id, org_id: orgId },
        });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
        }

        const member = await prisma.organizationMember.update({
            where: { id },
            data: { role },
        });
        log.info({ orgId, memberId: id, role, userId: ctx.userId }, 'Member updated');
        res.json(member);
    } catch (error) {
        log.error({ err: error, orgId, memberId: id }, 'Failed to update member');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update member' } });
    }
};

/**
 * DELETE /v1/admin/organizations/:orgId/members/:id
 * Remove a member from an organization
 */
export const removeMember = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const orgId = String(req.params.orgId);
    const id = String(req.params.id);

    try {
        const existing = await prisma.organizationMember.findFirst({
            where: { id, org_id: orgId },
        });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
        }

        await prisma.organizationMember.delete({ where: { id } });
        log.info({ orgId, memberId: id, userId: ctx.userId }, 'Member removed');
        res.status(204).send();
    } catch (error) {
        log.error({ err: error, orgId, memberId: id }, 'Failed to remove member');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove member' } });
    }
};
