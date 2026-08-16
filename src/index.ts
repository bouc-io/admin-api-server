// Initialize OpenTelemetry FIRST so auto-instrumentation can patch http/express
// before they are imported below. No-op unless OTEL is configured (see lib/tracing.ts).
import './lib/tracing';
import 'dotenv/config';
import app from './app';
import { createComponentLogger } from './lib/logger';

const log = createComponentLogger('server');
const port = process.env.PORT || 3002;

const server = app.listen(port, () => {
    log.info({ port }, 'Admin API server running');
});

const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down gracefully...');

    server.close(async () => {
        log.info('HTTP server closed');
        process.exit(0);
    });

    setTimeout(() => {
        log.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
