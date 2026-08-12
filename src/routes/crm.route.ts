
import express from 'express';
import multer from 'multer';
import crmController from '../controllers/crm.controller';
import departmentController from '../controllers/department.controller';
import hrController from '../controllers/hr.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import { authLimiter, otpLimiter } from '../middleware/rate-limit.middleware';

const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_AVATAR_MIME.has(file.mimetype)),
});

const router = express.Router();

router.post('/login',           authLimiter, crmController.login);
router.post('/logout',          crmController.logout);
router.post('/forgot-password', otpLimiter, crmController.forgotPassword);
router.post('/reset-password',  otpLimiter, crmController.confirmResetPassword);

router.use(crmAuth());

router.get('/me',             crmController.getMe);
router.patch('/me/avatar',    avatarUpload.single('avatar'), crmController.updateMeAvatar);
router.patch('/me/screenshot-privacy', crmController.updateMyScreenshotPrivacy);
router.post('/token-refresh', crmController.tokenRefresh);
router.post('/time-clock',    crmController.timeClock);
router.get('/time-logs',   crmController.getTimeLogs);

router.get('/next-employee-id',           crmController.getNextEmployeeId);
router.get('/users',                      crmController.getUsers);
router.post('/users',                     crmController.createUser);
router.patch('/users/:id',                crmController.updateUser);
router.patch('/users/:id/status',         crmController.toggleUserStatus);
router.patch('/users/:id/reset-password', crmController.resetPassword);
router.post('/users/:id/offboard',        crmController.offboardUser);
router.delete('/users/:id',               crmController.deleteUser);

router.get('/departments',                       departmentController.listAllDepartments);
router.post('/departments',                      departmentController.createDepartment);
router.patch('/departments/reorder',             departmentController.reorderDepartments);
router.get('/departments/:id/members',           departmentController.listDepartmentMembers);
router.patch('/departments/:id/members/:memberId', departmentController.removeDepartmentMember);
router.patch('/departments/:id',                 departmentController.updateDepartment);
router.delete('/departments/:id',                departmentController.deactivateDepartment);

router.get('/hr/milestones',           hrController.getMilestones);
router.get('/hr/offboarded',           hrController.getOffboarded);
router.post('/hr/milestones/trigger',  hrController.triggerMilestones);

// Feed/DayPulse routes are intentionally NOT defined here. This router is
// mounted at "/crm", which matches "/crm/feeds/*" before the dedicated
// "/crm/feeds" mount in routes/index.ts ever gets a chance to run. Defining
// them here shadowed feed.route.ts entirely, so uploads reached createPost
// with no multer in the chain — req.files/req.body were never populated and
// every attachment post failed with "Post content cannot be empty". Keep them
// in feed.route.ts, which owns the attachment-parsing middleware.

export default router;