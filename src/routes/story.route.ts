import express from 'express';
import multer from 'multer';
import storyController from '../controllers/story.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const ALLOWED_MEDIA = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024 }, // room for a 2-min clip
  fileFilter: (_req, file, cb) => {
    // The client-generated video thumbnail arrives as image/jpeg on the
    // "thumbnail" field — always allow that; validate the primary media field.
    if (file.fieldname === 'thumbnail') return cb(null, file.mimetype.startsWith('image/'));
    cb(null, ALLOWED_MEDIA.has(file.mimetype));
  },
});

const router = express.Router();

router.use(crmAuth());

// Static routes MUST precede "/:id".
router.get('/feed', storyController.getFeed);
router.post(
  '/',
  upload.fields([{ name: 'media', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]),
  storyController.createStory
);

router.get('/:id', storyController.getStory);
router.post('/:id/view', storyController.markViewed);
router.post('/:id/react', storyController.react);
router.post('/:id/comment', storyController.comment);
router.delete('/:id', storyController.deleteStory);

export default router;