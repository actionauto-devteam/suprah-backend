
import express from 'express';
import multer from 'multer';
import crmController from '../controllers/crm.controller';
import hrController from '../controllers/hr.controller';
import feedController from '../controllers/feed.controller';
import feedCommentController from '../controllers/feedComment.controller';
import feedReactionRouter from './feedReaction.routes';
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

router.get('/hr/milestones',           hrController.getMilestones);
router.get('/hr/offboarded',           hrController.getOffboarded);
router.post('/hr/milestones/trigger',  hrController.triggerMilestones);

router.get('/feeds',        feedController.getPosts);
router.post('/feeds',       feedController.createPost);
router.put('/feeds/:id',    feedController.updatePost);
router.delete('/feeds/:id', feedController.deletePost);

router.use('/feeds/reactions', feedReactionRouter);

router.get('/feeds/:postId/comments',               feedCommentController.getComments);
router.post('/feeds/:postId/comments',              feedCommentController.addComment);
router.delete('/feeds/:postId/comments/:commentId', feedCommentController.deleteComment);

export default router;