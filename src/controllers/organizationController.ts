import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';
import { BOUC_ROLES } from '../lib/roles';

const log = createComponentLogger('organization-controller');

const TIER_LIMITS: Record<string, { max_seats: number; monthly_spend: number }> = {
    internal:   { max_seats: Number.MAX_SAFE_INTEGER, monthly_spend: 0   },
    free:       { max_seats: Number.MAX_SAFE_INTEGER, monthly_spend: 0   }, // public org serves all public users
    personal:   { max_seats: 5,                       monthly_spend: 29  },
    company:    { max_seats: 25,                      monthly_spend: 149 },
    enterprise: { max_seats: 100,                     monthly_spend: 499 },
};

const VALID_STATUSES = ['active', 'suspended', 'trial'];
const VALID_TIERS = ['internal', 'free', 'personal', 'company', 'enterprise'];

/**
 * GET /v1/admin/organizations
 * List all organizations
 */
export const listOrganizations = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    try {
        const organizations = await prisma.organization.findMany({
            orderBy: { created_at: 'desc' },
            include: { _count: { select: { members: true } } },
        });
        res.json({
            organizations: organizations.map(org => ({
                ...org,
                ...(TIER_LIMITS[org.tier] ?? { max_seats: 0, monthly_spend: 0 }),
            })),
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to list organizations');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list organizations' } });
    }
};

/**
 * GET /v1/admin/organizations/:id
 * Get a single organization with its members
 */
export const getOrganization = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);

    try {
        const organization = await prisma.organization.findUnique({
            where: { id },
            include: { members: true },
        });
        if (!organization) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }
        res.json({
            ...organization,
            ...(TIER_LIMITS[organization.tier] ?? { max_seats: 0, monthly_spend: 0 }),
        });
    } catch (error) {
        log.error({ err: error, id }, 'Failed to get organization');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get organization' } });
    }
};

/**
 * POST /v1/admin/organizations
 * Create a new organization
 */
export const createOrganization = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const { name, slug, tier, status, sso_config } = req.body;
    if (!name || !slug || !tier) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'name, slug, and tier are required' },
        });
    }

    if (!VALID_TIERS.includes(tier)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `tier must be one of: ${VALID_TIERS.join(', ')}` },
        });
    }

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        });
    }

    try {
        const organization = await prisma.organization.create({
            data: {
                name,
                slug,
                tier,
                ...(status !== undefined && { status }),
                ...(sso_config !== undefined && { sso_config }),
            },
        });
        log.info({ id: organization.id, slug, userId: ctx.userId }, 'Organization created');
        res.status(201).json(organization);
    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: { code: 'CONFLICT', message: 'An organization with this slug already exists' } });
        }
        log.error({ err: error }, 'Failed to create organization');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create organization' } });
    }
};

/**
 * PUT /v1/admin/organizations/:id
 * Update an organization
 */
export const updateOrganization = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);
    const { name, slug, tier, status, sso_config } = req.body;

    if (tier !== undefined && !VALID_TIERS.includes(tier)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `tier must be one of: ${VALID_TIERS.join(', ')}` },
        });
    }

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        });
    }

    try {
        const existing = await prisma.organization.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }

        const organization = await prisma.organization.update({
            where: { id },
            data: {
                ...(name !== undefined && { name }),
                ...(slug !== undefined && { slug }),
                ...(tier !== undefined && { tier }),
                ...(status !== undefined && { status }),
                ...(sso_config !== undefined && { sso_config }),
            },
        });
        log.info({ id, userId: ctx.userId }, 'Organization updated');
        res.json(organization);
    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: { code: 'CONFLICT', message: 'An organization with this slug already exists' } });
        }
        log.error({ err: error, id }, 'Failed to update organization');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update organization' } });
    }
};

/**
 * DELETE /v1/admin/organizations/:id
 * Delete an organization (cascades to members)
 */
export const deleteOrganization = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    const id = String(req.params.id);

    try {
        const existing = await prisma.organization.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }

        await prisma.organization.delete({ where: { id } });
        log.info({ id, userId: ctx.userId }, 'Organization deleted');
        res.status(204).send();
    } catch (error) {
        log.error({ err: error, id }, 'Failed to delete organization');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete organization' } });
    }
};

/**
 * GET /v1/config/organizations/:id
 * Returns org details. Scope: bouc_* = any org; org_* = own org only; public_user = public org only.
 */
export const getOrganizationConfig = async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ctx = getUserContextFromRequest(req);

    try {
        const organization = await prisma.organization.findUnique({
            where: { id },
            select: { id: true, name: true, slug: true, tier: true },
        });
        if (!organization) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }

        // Scope check: bouc_* roles have unrestricted access
        if (ctx && !ctx.roles.some(r => BOUC_ROLES.includes(r as typeof BOUC_ROLES[number]))) {
            const isPublicUser = ctx.roles.includes('public_user');
            if (isPublicUser && organization.slug !== 'public') {
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to public organization' } });
            }
            if (!isPublicUser && organization.id !== ctx.orgId) {
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
            }
        }

        res.json(organization);
    } catch (error) {
        log.error({ err: error, id }, 'Failed to fetch organization config');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch organization config' } });
    }
};

/**
 * GET /v1/config/organizations/by-slug/:slug
 * Returns org by slug. Scope: bouc_* = any org; org_* = own org only; public_user = public org only.
 */
export const getOrganizationBySlug = async (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    const ctx = getUserContextFromRequest(req);

    try {
        const organization = await prisma.organization.findUnique({
            where: { slug },
            select: { id: true, name: true, slug: true, tier: true },
        });
        if (!organization) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
        }

        // Scope check: bouc_* roles have unrestricted access
        if (ctx && !ctx.roles.some(r => BOUC_ROLES.includes(r as typeof BOUC_ROLES[number]))) {
            const isPublicUser = ctx.roles.includes('public_user');
            if (isPublicUser && organization.slug !== 'public') {
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to public organization' } });
            }
            if (!isPublicUser && organization.id !== ctx.orgId) {
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
            }
        }

        res.json(organization);
    } catch (error) {
        log.error({ err: error, slug }, 'Failed to fetch organization by slug');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch organization config' } });
    }
};
