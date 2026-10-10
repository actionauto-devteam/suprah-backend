import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/crmLeadGroup.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.listGroups);
router.post('/', ctrl.createGroup);
router.patch('/:id', ctrl.updateGroup);
router.delete('/:id', ctrl.deleteGroup);

export default router;
