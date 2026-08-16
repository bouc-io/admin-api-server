export class AdminError extends Error {
    code: string;
    retryable: boolean;

    constructor(message: string, code: string, retryable: boolean) {
        super(message);
        this.name = 'AdminError';
        this.code = code;
        this.retryable = retryable;
    }
}

export class ValidationError extends AdminError {
    field?: string;

    constructor(message: string, field?: string) {
        super(message, 'VALIDATION_ERROR', false);
        this.name = 'ValidationError';
        this.field = field;
    }
}

export class DatabaseError extends AdminError {
    constructor(message: string, retryable: boolean = true) {
        super(message, 'DATABASE_ERROR', retryable);
        this.name = 'DatabaseError';
    }
}

export class NotFoundError extends AdminError {
    constructor(message: string) {
        super(message, 'NOT_FOUND', false);
        this.name = 'NotFoundError';
    }
}

export class ExternalServiceError extends AdminError {
    constructor(message: string) {
        super(message, 'EXTERNAL_SERVICE_ERROR', true);
        this.name = 'ExternalServiceError';
    }
}
