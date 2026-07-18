import { Router } from 'express';
import {
    getSsoConfig,
    saveSsoConfig,
    testSsoConnection,
    enableSso,
    disableSso,
    deleteSsoConfig,
} from '../controllers/ssoController';
import { validate } from '../middleware/validate';
import { saveSsoConfigSchema } from '../schemas';

/**
 * SSO routes — mounted at /v1/admin/organizations/:id/sso
 *
 * Auth: inherits requireRoles(BOUC_ADMIN, ORG_ADMIN, ORG_ADMIN_ENTERPRISE) from organizationRoutes.
 * Scope: org_admin / org_admin_enterprise are pinned to their own org (enforced in controller).
 */
const router = Router({ mergeParams: true });

router.get('/', getSsoConfig);
router.put('/', validate(saveSsoConfigSchema), saveSsoConfig);
router.post('/test', testSsoConnection);
router.post('/enable', enableSso);
router.post('/disable', disableSso);
router.delete('/', deleteSsoConfig);

export default router;
