import express from 'express';
import multer from 'multer';
import pmController from '../controllers/projectManagement.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

const router = express.Router();

router.use(crmAuth());

router.get('/members/search', pmController.searchMembers);

router.get('/my-tasks', pmController.getMyTasks);

router.get('/notifications/count', pmController.getNotificationCount);
router.get('/notifications',       pmController.getNotifications);
router.post('/notifications/read', pmController.markNotificationsRead);

router.post('/groups',                 pmController.createGroup);
router.get('/groups',                  pmController.getGroups);
router.get('/groups/:groupId/tree',    pmController.getGroupTree);
router.patch('/groups/:groupId',       pmController.updateGroup);
router.delete('/groups/:groupId',      pmController.deleteGroup);

router.post('/groups/:groupId/sections', pmController.createSection);
router.patch('/sections/:sectionId',     pmController.updateSection);
router.delete('/sections/:sectionId',    pmController.deleteSection);

router.post('/sections/:sectionId/folders', pmController.createFolder);
router.patch('/folders/:folderId',          pmController.updateFolder);
router.delete('/folders/:folderId',         pmController.deleteFolder);

router.post('/folders/:folderId/tasks', attachmentUpload.array('attachments', 10), pmController.createTask);
router.get('/tasks/:taskId',            pmController.getTask);
router.patch('/tasks/:taskId',          pmController.updateTask);
router.patch('/tasks/:taskId/status',   pmController.updateTaskStatus);
router.delete('/tasks/:taskId',         pmController.deleteTask);

router.get('/tasks/:taskId/comments',  pmController.getComments);
router.post('/tasks/:taskId/comments', attachmentUpload.array('attachments', 5), pmController.addComment);
router.delete('/comments/:commentId',  pmController.deleteComment);

export default router;