import express from 'express';
import multer from 'multer';
import pmController from '../controllers/projectManagement.controller';
import crmAuth from '../middleware/crmAuth.middleware';

// Same in-memory multer setup as feeds / DayPulse. 25 MB per file, max 10
// files per request. Files land in the private R2 bucket via storageService.
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

const router = express.Router();

router.use(crmAuth());

// ── Member search (org-scoped) ──
router.get('/members/search', pmController.searchMembers);

// ── My Tasks / Completed Tasks (cross-group, paginated, newest first) ──
router.get('/my-tasks', pmController.getMyTasks);

// ── Mentions inbox (cross-group, paginated, newest first) ──
router.get('/mentions', pmController.getMentions);

// ── Notifications (sidebar badge) ──
// Declared before any /:param routes for clarity, though paths don't collide.
router.get('/notifications/count', pmController.getNotificationCount);
router.get('/notifications',       pmController.getNotifications);
router.post('/notifications/read', pmController.markNotificationsRead);

// ── Project Groups ──
router.post('/groups',                 pmController.createGroup);
router.get('/groups',                  pmController.getGroups);
router.get('/groups/:groupId/tree',    pmController.getGroupTree);
router.patch('/groups/:groupId',       pmController.updateGroup);
router.delete('/groups/:groupId',      pmController.deleteGroup);

// ── Sections ──
router.post('/groups/:groupId/sections', pmController.createSection);
router.patch('/sections/:sectionId',     pmController.updateSection);
router.delete('/sections/:sectionId',    pmController.deleteSection);

// ── Folder Groups ──
router.post('/sections/:sectionId/folders', pmController.createFolder);
router.patch('/folders/:folderId',          pmController.updateFolder);
router.delete('/folders/:folderId',         pmController.deleteFolder);

// ── Tasks ──
router.post('/folders/:folderId/tasks', attachmentUpload.array('attachments', 10), pmController.createTask);
router.get('/tasks/:taskId',            pmController.getTask);
router.patch('/tasks/:taskId',          pmController.updateTask);
router.patch('/tasks/:taskId/status',   pmController.updateTaskStatus);
router.delete('/tasks/:taskId',         pmController.deleteTask);
router.post('/tasks/:taskId/attachments', attachmentUpload.array('attachments', 10), pmController.addTaskAttachments);
router.delete('/tasks/:taskId/attachments/:attachmentId', pmController.deleteTaskAttachment);

// ── Task comments ──
router.get('/tasks/:taskId/comments',  pmController.getComments);
router.post('/tasks/:taskId/comments', attachmentUpload.array('attachments', 5), pmController.addComment);
router.patch('/comments/:commentId',   pmController.updateComment);
router.delete('/comments/:commentId',  pmController.deleteComment);

export default router;