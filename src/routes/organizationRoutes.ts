import { Router } from 'express';
import {
    listOrganizations,
    getOrganization,
    createOrganization,
    updateOrganization,
    deleteOrganization,
} from '../controllers/organizationController';
import {
    listMembers,
    addMember,
    updateMember,
    removeMember,
} from '../controllers/organizationMemberController';
import { requireRoles } from '../lib/auth';
import { ROLES } from '../lib/roles';
import { validate } from '../middleware/validate';
import {
    createOrganizationSchema,
    updateOrganizationSchema,
    addMemberSchema,
    updateMemberSchema,
} from '../schemas';
import ssoRoutes from './ssoRoutes';

const router = Router();

// bouc_admin: full CRUD; org_admin / org_admin_enterprise: own org only (enforced in controller)
router.use(requireRoles(ROLES.BOUC_ADMIN, ROLES.ORG_ADMIN, ROLES.ORG_ADMIN_ENTERPRISE));

// Organization CRUD
router.get('/', listOrganizations);
router.post('/', validate(createOrganizationSchema), createOrganization);
router.get('/:id', getOrganization);
router.put('/:id', validate(updateOrganizationSchema), updateOrganization);
router.delete('/:id', deleteOrganization);

// Organization member management
router.get('/:orgId/members', listMembers);
router.post('/:orgId/members', validate(addMemberSchema), addMember);
router.put('/:orgId/members/:id', validate(updateMemberSchema), updateMember);
router.delete('/:orgId/members/:id', removeMember);

// SSO configuration per organization
router.use('/:id/sso', ssoRoutes);

export default router;
