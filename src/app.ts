import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './lib/swagger';
import healthRoutes from './routes/healthRoutes';
import instructionsRoutes from './routes/instructionsRoutes';
import llmProvidersRoutes from './routes/llmProvidersRoutes';
import llmAssignmentsRoutes from './routes/llmAssignmentsRoutes';
import organizationRoutes from './routes/organizationRoutes';
import systemRoutes from './routes/systemRoutes';
import mcpServersRoutes from './routes/mcpServersRoutes';
import configRoutes from './routes/configRoutes';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requireRoles } from './lib/auth';
import { ADMIN_PORTAL_ROLES } from './lib/roles';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Interactive API docs. Served in every environment: exposure is gated at the edge
// (Istio + oauth2-proxy), not by NODE_ENV, and neither path is routed externally.
// /openapi.json is read in-mesh by apidocs-api-server, which aggregates every
// service's spec at api.<domain>/v1/api-docs. Mounted before the /v1/admin role
// guard so the aggregator needs no token.
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/openapi.json', (_req, res) => res.json(openApiSpec));

// Request / response logging (debug: full payload, info: canonical summary line)
app.use(requestLogger);

// Health routes (before other routes for k8s probes)
app.use('/health', healthRoutes);

// Belt-and-suspenders: block any role without Admin Portal access before any /v1/admin route.
// Individual route files add finer-grained guards per-route group.
app.use('/v1/admin', requireRoles(...ADMIN_PORTAL_ROLES));

// Admin routes (JWT auth enforced by global guard above + per-route guards)
app.use('/v1/admin/instructions', instructionsRoutes);
app.use('/v1/admin/llm-providers', llmProvidersRoutes);
app.use('/v1/admin/llm-assignments', llmAssignmentsRoutes);
app.use('/v1/admin/organizations', organizationRoutes);
app.use('/v1/admin/system', systemRoutes);
app.use('/v1/admin/mcp-servers', mcpServersRoutes);

// Internal config routes (service-to-service, no user auth required)
app.use('/v1/config', configRoutes);

// 404 + global error handler (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
