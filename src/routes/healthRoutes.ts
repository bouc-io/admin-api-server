import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

interface HealthCheckResult {
    status: 'healthy' | 'degraded' | 'unhealthy';
    latency_ms?: number;
    error?: string;
}

async function checkDatabase(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: 'healthy', latency_ms: Date.now() - start };
    } catch (error) {
        return {
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * GET /health
 * Basic liveness check
 */
router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
});

/**
 * GET /health/detailed
 * Full dependency check
 */
router.get('/detailed', async (_req: Request, res: Response) => {
    const database = await checkDatabase();

    const overallStatus: 'healthy' | 'degraded' | 'unhealthy' =
        database.status === 'unhealthy' ? 'unhealthy' : 'healthy';

    const statusCode = overallStatus === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json({
        status: overallStatus,
        checks: { database },
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /health/ready
 * Kubernetes readiness probe — requires DB
 */
router.get('/ready', async (_req: Request, res: Response) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.status(200).json({ status: 'ready' });
    } catch {
        res.status(503).json({ status: 'not ready' });
    }
});

/**
 * GET /health/live
 * Kubernetes liveness probe — always succeeds
 */
router.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'live' });
});

export default router;
