import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const logger = pino({
    level: LOG_LEVEL,
    formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => ({
            pid: bindings.pid,
            host: bindings.hostname,
        }),
    },
    base: {
        agent: 'admin-api-server',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});

export const createComponentLogger = (component: string) => {
    return logger.child({ component });
};

export const createRequestLogger = (requestId: string) => {
    return logger.child({ request_id: requestId, component: 'http' });
};

export interface CanonicalLogData {
    duration_ms: number;
    status: 'success' | 'failure';
    metrics?: Record<string, number>;
}

export const logCanonical = (
    log: pino.Logger,
    message: string,
    data: CanonicalLogData
) => {
    log.info(
        {
            duration_ms: data.duration_ms,
            status: data.status,
            ...data.metrics,
        },
        message
    );
};
