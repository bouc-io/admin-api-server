import { Router } from 'express';
import {
    listMcpServers,
    createMcpServer,
    updateMcpServer,
    deleteMcpServer,
} from '../controllers/mcpServersController';
import { requireRoles } from '../lib/auth';
import { ROLES } from '../lib/roles';
import { validate } from '../middleware/validate';
import { createMcpServerSchema, updateMcpServerSchema } from '../schemas';

const router = Router();

// MCP servers are global infrastructure config, managed by bouc.io staff.
const READ_ROLES = [ROLES.BOUC_ADMIN, ROLES.BOUC_SRE, ROLES.BOUC_ENGINEER] as const;
const WRITE_ROLES = [ROLES.BOUC_ADMIN, ROLES.BOUC_SRE] as const;

/**
 * @openapi
 * /v1/admin/mcp-servers:
 *   get:
 *     summary: List configured MCP servers
 *     tags: [MCP Servers]
 *     responses:
 *       '200': { description: MCP server list }
 *       '403': { description: Forbidden }
 *   post:
 *     summary: Register a new MCP server
 *     tags: [MCP Servers]
 *     responses:
 *       '201': { description: MCP server created }
 *       '400': { description: Validation error }
 */
router.get('/', requireRoles(...READ_ROLES), listMcpServers);
router.post('/', requireRoles(...WRITE_ROLES), validate(createMcpServerSchema), createMcpServer);
router.put('/:id', requireRoles(...WRITE_ROLES), validate(updateMcpServerSchema), updateMcpServer);
router.delete('/:id', requireRoles(...WRITE_ROLES), deleteMcpServer);

export default router;
