import { Router } from 'express';
import { getSystemHealth } from '../controllers/systemController';
import { requireRoles } from '../lib/auth';
import { ROLES } from '../lib/roles';

const router = Router();

router.use(requireRoles(
    ROLES.BOUC_ADMIN, ROLES.BOUC_SRE, ROLES.BOUC_ENGINEER,
    ROLES.ORG_ADMIN, ROLES.ORG_ADMIN_ENTERPRISE,
));

// GET /v1/admin/system/health
router.get('/health', getSystemHealth);

export default router;
