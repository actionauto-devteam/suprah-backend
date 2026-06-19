// crm.route.ts

import express from 'express';
import multer from 'multer';
import crmController from '../controllers/crm.controller';
import hrController from '../controllers/hr.controller';
import feedController from '../controllers/feed.controller';
import feedCommentController from '../controllers/feedComment.controller';
import feedReactionRouter from './feedReaction.routes';
import crmAuth from '../middleware/crmAuth.middleware';

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// ── Public routes ──
router.post('/login',           crmController.login);
router.post('/logout',          crmController.logout);
router.post('/forgot-password', crmController.forgotPassword);
router.post('/reset-password',  crmController.confirmResetPassword);

router.use(crmAuth());

// ── General employee routes ──
router.get('/me',             crmController.getMe);
router.patch('/me/avatar',    avatarUpload.single('avatar'), crmController.updateMeAvatar);
router.post('/token-refresh', crmController.tokenRefresh);
router.post('/time-clock',    crmController.timeClock);
router.get('/time-logs',   crmController.getTimeLogs);

// ── User management ──
router.get('/next-employee-id',           crmController.getNextEmployeeId);
router.get('/users',                      crmController.getUsers);
router.post('/users',                     crmController.createUser);
router.patch('/users/:id',                crmController.updateUser);
router.patch('/users/:id/status',         crmController.toggleUserStatus);
router.patch('/users/:id/reset-password', crmController.resetPassword);
router.post('/users/:id/offboard',        crmController.offboardUser);
router.delete('/users/:id',               crmController.deleteUser);

// ── HR ──
router.get('/hr/milestones',           hrController.getMilestones);
router.get('/hr/offboarded',           hrController.getOffboarded);
router.post('/hr/milestones/trigger',  hrController.triggerMilestones);

// ── Feed posts ──
router.get('/feeds',        feedController.getPosts);
router.post('/feeds',       feedController.createPost);
router.put('/feeds/:id',    feedController.updatePost);
router.delete('/feeds/:id', feedController.deletePost);

// ── Feed reactions ──────────────────────────────────────────────── ← ADD THIS BLOCK
// Must be declared BEFORE /feeds/:postId/comments so Express doesn't
// misinterpret "reactions" as a :postId param.
router.use('/feeds/reactions', feedReactionRouter);

// ── Feed comments ──
router.get('/feeds/:postId/comments',               feedCommentController.getComments);
router.post('/feeds/:postId/comments',              feedCommentController.addComment);
router.delete('/feeds/:postId/comments/:commentId', feedCommentController.deleteComment);

export default router;