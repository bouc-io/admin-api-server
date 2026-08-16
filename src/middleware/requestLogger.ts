import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger';

const SENSITIVE_KEYS = new Set(['api_key', 'api_key_enc', 'password', 'secret', 'token', 'authorization']);

/** Recursively redact sensitive keys from an object (shallow-safe for plain JSON bodies). */
function redact(obj: unknown, depth = 0): unknown {
    if (depth > 5 || obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => redact(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    const startMs = Date.now();
    const log = logger.child({ request_id: requestId, component: 'http' });

    // Attach request_id to the request object so controllers can reference it if needed
    (req as Request & { requestId: string }).requestId = requestId;

    const hasBody = req.body && Object.keys(req.body).length > 0;

    log.debug(
        {
            method: req.method,
            url: req.url,
            path: req.path,
            query: Object.keys(req.query).length ? req.query : undefined,
            body: hasBody ? redact(req.body) : undefined,
            user_agent: req.headers['user-agent'],
        },
        'request received'
    );

    // Intercept res.json to capture outgoing body at debug level
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
        const elapsed = Date.now() - startMs;
        const statusCode = res.statusCode;

        log.debug(
            {
                method: req.method,
                path: req.path,
                status: statusCode,
                elapsed_ms: elapsed,
                response_body: statusCode >= 400 ? body : undefined, // always log error bodies; skip success bodies to keep noise low
            },
            'response sent'
        );

        // Canonical info-level summary — always emitted regardless of LOG_LEVEL
        log.info(
            {
                method: req.method,
                path: req.path,
                status: statusCode,
                elapsed_ms: elapsed,
            },
            'http request'
        );

        return originalJson(body);
    };

    next();
}
