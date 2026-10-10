import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadMarketingContactCsv } from '../middleware/marketingContactImport.middleware';
import * as ctrl from '../controllers/marketingContact.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/import-labels', ctrl.listMarketingContactImportLabels);
router.get('/', ctrl.listMarketingContacts);
router.post('/import', uploadMarketingContactCsv, ctrl.importMarketingContacts);
router.delete('/:id', ctrl.deleteMarketingContact);

export default router;
