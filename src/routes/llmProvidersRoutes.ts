import { Router } from 'express';
import {
    listProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
} from '../controllers/llmProvidersController';
import { requireRoles } from '../lib/auth';
import { ROLES } from '../lib/roles';
import { validate } from '../middleware/validate';
import { createProviderSchema, updateProviderSchema } from '../schemas';

const router = Router();

// Read: bouc_engineer may view providers but not modify them
const READ_ROLES  = [ROLES.BOUC_ADMIN, ROLES.BOUC_SRE, ROLES.BOUC_ENGINEER, ROLES.ORG_ADMIN_ENTERPRISE] as const;
const WRITE_ROLES = [ROLES.BOUC_ADMIN, ROLES.BOUC_SRE, ROLES.ORG_ADMIN_ENTERPRISE] as const;

/**
 * @openapi
 * /v1/admin/llm-providers:
 *   get:
 *     summary: List configured LLM providers
 *     tags: [LLM Providers]
 *     responses:
 *       '200': { description: Provider list }
 *       '403': { description: Forbidden (requires admin portal role) }
 *   post:
 *     summary: Create an LLM provider config
 *     tags: [LLM Providers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, provider]
 *             properties:
 *               name: { type: string }
 *               provider: { type: string, example: anthropic }
 *               api_endpoint: { type: string }
 *               api_key: { type: string }
 *               models: { type: array, items: { type: string } }
 *               is_active: { type: boolean }
 *     responses:
 *       '201': { description: Provider created }
 *       '400': { description: Validation error }
 */
router.get('/', requireRoles(...READ_ROLES), listProviders);
router.post('/', requireRoles(...WRITE_ROLES), validate(createProviderSchema), createProvider);
router.put('/:id', requireRoles(...WRITE_ROLES), validate(updateProviderSchema), updateProvider);
router.delete('/:id', requireRoles(...WRITE_ROLES), deleteProvider);
router.post('/:id/test', requireRoles(...WRITE_ROLES), testProvider);

export default router;
