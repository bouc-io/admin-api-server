import { Router } from 'express';
import { listAssignments, updateAssignment } from '../controllers/llmAssignmentsController';
import { requireRoles } from '../lib/auth';
import { ROLES } from '../lib/roles';
import { validate } from '../middleware/validate';
import { updateLlmAssignmentSchema } from '../schemas';

const router = Router();

router.use(requireRoles(ROLES.BOUC_ADMIN, ROLES.BOUC_ENGINEER, ROLES.ORG_ADMIN_ENTERPRISE));

router.get('/', listAssignments);
router.put('/:useCase', validate(updateLlmAssignmentSchema), updateAssignment);

export default router;
