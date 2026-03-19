import express from 'express';
import crmController from '../controllers/crm.controller';
import feedController from '../controllers/feed.controller';
import feedCommentController from '../controllers/feedComment.controller'; // ← NEW
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Public routes — no authentication required
// ─────────────────────────────────────────────────────────────────────────────

router.post('/login',  crmController.login);
router.post('/logout', crmController.logout);

// ─────────────────────────────────────────────────────────────────────────────
// Authentication wall — every route below requires a valid CRM JWT
// ─────────────────────────────────────────────────────────────────────────────

router.use(crmAuth());

// ─────────────────────────────────────────────────────────────────────────────
// General employee routes
// ─────────────────────────────────────────────────────────────────────────────

router.get('/me',          crmController.getMe);
router.post('/time-clock', crmController.timeClock);
router.get('/time-logs',   crmController.getTimeLogs);

// ─────────────────────────────────────────────────────────────────────────────
// User management — admin only (role check enforced inside each controller)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/next-employee-id',    crmController.getNextEmployeeId);
router.get('/users',               crmController.getUsers);
router.post('/users',              crmController.createUser);
router.patch('/users/:id',         crmController.updateUser);
router.patch('/users/:id/status',  crmController.toggleUserStatus);
router.delete('/users/:id',        crmController.deleteUser);

// ─────────────────────────────────────────────────────────────────────────────
// Feed posts — org-scoped social timeline
// ─────────────────────────────────────────────────────────────────────────────

router.get('/feeds',         feedController.getPosts);    // Paginated feed (?page&limit)
router.post('/feeds',        feedController.createPost);  // Create a post
router.put('/feeds/:id',     feedController.updatePost);  // Edit a post (owner only)
router.delete('/feeds/:id',  feedController.deletePost);  // Delete a post (owner or admin)

// ─────────────────────────────────────────────────────────────────────────────
// Feed comments — nested under each post
// Any authenticated org member can add or view comments.
// Only the comment owner (or admin) can delete.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/feeds/:postId/comments',              feedCommentController.getComments);   // All comments for a post
router.post('/feeds/:postId/comments',             feedCommentController.addComment);    // Add a comment
router.delete('/feeds/:postId/comments/:commentId', feedCommentController.deleteComment); // Delete a comment

export default router;