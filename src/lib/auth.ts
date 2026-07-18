import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createComponentLogger } from './logger';
import { BOUC_ROLES } from './roles';

const log = createComponentLogger('auth');

export interface UserContext {
    userId: string;
    orgId: string | null;
    /** Resolved active org for this request: bouc_* staff can switch via X-Active-Org; org_admin is pinned to JWT org_id. */
    activeOrgId: string | null;
    roles: string[];
    accessToken: string;
}

export const isBoucRole = (roles: string[]): boolean =>
    roles.some((r) => BOUC_ROLES.includes(r as any));

export const getUserContextFromRequest = (req: Request): UserContext | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;

    const token = authHeader
        .split(',')
        .map((s) => s.trim())
        .find((s) => s.startsWith('Bearer '))
        ?.split(' ')[1];

    if (!token) return null;

    try {
        const decoded = jwt.decode(token) as Record<string, any> | null;
        const userId = decoded?.preferred_username || null;
        if (!userId) return null;

        const orgId = decoded?.org_id
            || (req.headers['x-auth-request-org'] as string)
            || null;

        const roles: string[] = decoded?.realm_access?.roles
            || (req.headers['x-auth-request-roles'] as string || '').split(',').filter(Boolean);

        const xActiveOrg = (req.headers['x-active-org'] as string) || null;
        // bouc_* staff can override active org via header (null = global/all-org view)
        // org_admin and below are always pinned to their JWT org_id
        const activeOrgId = isBoucRole(roles) ? (xActiveOrg ?? orgId) : orgId;

        return { userId, orgId, activeOrgId, roles, accessToken: token };
    } catch (error) {
        log.error({ err: error }, 'Failed to decode token');
        return null;
    }
};

export const getUserIdFromRequest = (req: Request): string | null => {
    const context = getUserContextFromRequest(req);
    return context?.userId || null;
};

export const requireRoles = (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
        const ctx = getUserContextFromRequest(req);
        if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
        if (allowed.length > 0 && !ctx.roles.some((r) => allowed.includes(r))) {
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
        }
        next();
    };
