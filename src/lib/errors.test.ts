import { describe, it, expect } from 'vitest';
import {
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ServiceUnavailableError,
} from './errors';

describe('ApiError hierarchy', () => {
  it('ApiError defaults to 500 / INTERNAL_ERROR', () => {
    const e = new ApiError('boom');
    expect(e.statusCode).toBe(500);
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e).toBeInstanceOf(Error);
  });

  it('carries an explicit status, code and details', () => {
    const e = new ApiError('bad', 418, 'TEAPOT', { hint: 'short and stout' });
    expect(e.statusCode).toBe(418);
    expect(e.code).toBe('TEAPOT');
    expect(e.details).toEqual({ hint: 'short and stout' });
  });

  it.each([
    [BadRequestError, 400, 'BAD_REQUEST'],
    [UnauthorizedError, 401, 'UNAUTHORIZED'],
    [ForbiddenError, 403, 'FORBIDDEN'],
    [NotFoundError, 404, 'NOT_FOUND'],
    [ConflictError, 409, 'CONFLICT'],
    [ValidationError, 422, 'VALIDATION_ERROR'],
    [ServiceUnavailableError, 503, 'SERVICE_UNAVAILABLE'],
  ])('%s maps to status %i / code %s', (Ctor, status, code) => {
    const e = new (Ctor as new () => ApiError)();
    expect(e).toBeInstanceOf(ApiError);
    expect(e.statusCode).toBe(status);
    expect(e.code).toBe(code);
    expect(e.name).toBe((Ctor as { name: string }).name);
  });

  it('preserves details on errors that accept them', () => {
    const e = new BadRequestError('nope', { field: 'email' });
    expect(e.details).toEqual({ field: 'email' });
  });
});
