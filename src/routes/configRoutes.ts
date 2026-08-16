import { Router } from 'express';
import { listActiveInstructions } from '../controllers/instructionsController';
import { getAssignmentConfig } from '../controllers/llmAssignmentsController';
import { getOrganizationConfig, getOrganizationBySlug } from '../controllers/organizationController';
import { getMcpServersConfig } from '../controllers/mcpServersController';
import { requireRoles } from '../lib/auth';

const router = Router();

// GET /v1/config/mcp-servers - enabled MCP servers for agent-api-server.
// Registered BEFORE the requireRoles() guard: the agent fetches this at startup
// where no user JWT exists. It is a service-to-service call protected by network
// isolation (admin-api-server is not externally reachable), same trust model as
// the other internal config endpoints. Returns decrypted bearer tokens.
router.get('/mcp-servers', getMcpServersConfig);

// Config routes are role-guarded: bouc_* = full access; org_* = own org; public_user = public org.
// Scoping is enforced per-controller. requireRoles() with no args = any valid token required.
router.use(requireRoles());

// GET /v1/config/instructions - active instructions for internal services (no auth)
router.get('/instructions', listActiveInstructions);

// GET /v1/config/llm-assignment/:useCase - LLM assignment config for internal services (no auth)
router.get('/llm-assignment/:useCase', getAssignmentConfig);

// GET /v1/config/organizations/:id - org details for internal services (no auth)
router.get('/organizations/by-slug/:slug', getOrganizationBySlug);
router.get('/organizations/:id', getOrganizationConfig);

export default router;
