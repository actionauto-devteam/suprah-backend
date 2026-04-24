import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import dayPulseController from '../controllers/Daypulse.controller';

const router = Router();

// All DayPulse routes require CRM authentication
router.use(crmAuth());

// ── Report dates (must come before /:id to avoid route conflict) ──
router.get('/dates', dayPulseController.getReportDates);

// ── Core CRUD ──
router.get('/',     dayPulseController.getReports);
router.post('/',    dayPulseController.createReport);
router.put('/:id',  dayPulseController.updateReport);
router.delete('/:id', dayPulseController.deleteReport);

export default router;