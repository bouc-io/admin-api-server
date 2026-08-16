import { Request, Response } from 'express';
import { getUserIdFromRequest } from '../lib/auth';
import { aggregateHealth } from '../services/healthAggregatorService';
import { createComponentLogger } from '../lib/logger';

const log = createComponentLogger('system-controller');

/**
 * GET /v1/admin/system/health
 * Returns aggregated health status of all downstream services. Requires JWT.
 */
export const getSystemHealth = async (req: Request, res: Response) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }

    try {
        const result = await aggregateHealth();
        res.json(result);
    } catch (error) {
        log.error({ err: error }, 'Failed to aggregate system health');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to check system health' } });
    }
};
