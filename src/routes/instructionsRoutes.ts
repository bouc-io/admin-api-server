import { Router } from 'express';
import {
    listInstructions,
    createInstruction,
    updateInstruction,
    deleteInstruction,
    toggleInstruction,
} from '../controllers/instructionsController';
import { requireRoles } from '../lib/auth';
import { ROLES } from '../lib/roles';
import { validate } from '../middleware/validate';
import { createInstructionSchema, updateInstructionSchema } from '../schemas';

const router = Router();

router.use(requireRoles(
    ROLES.BOUC_ADMIN, ROLES.BOUC_ENGINEER, ROLES.BOUC_SRE,
    ROLES.ORG_ADMIN, ROLES.ORG_ADMIN_ENTERPRISE,
));

router.get('/', listInstructions);
router.post('/', validate(createInstructionSchema), createInstruction);
router.put('/:id', validate(updateInstructionSchema), updateInstruction);
router.delete('/:id', deleteInstruction);
router.patch('/:id/toggle', toggleInstruction);

export default router;
