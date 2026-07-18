import { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';
import { ApiError } from '../lib/errors';

/**
 * 404 handler. Mount AFTER all routes and BEFORE errorHandler.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
};

/**
 * Global error handler. Must be registered LAST (Express identifies it by its 4 args).
 * Produces a consistent JSON shape and never leaks internal details on 500s.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Validation errors (thrown by the validate() middleware) -> 400
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      logger.error({ err, code: err.code, path: req.originalUrl }, err.message);
    } else {
      logger.warn({ code: err.code, path: req.originalUrl }, err.message);
    }
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  // Unknown / unexpected error -> 500 (do not leak internals to the client)
  logger.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err, path: req.originalUrl },
    'Unhandled error'
  );
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};
