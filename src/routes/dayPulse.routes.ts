import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crmAuth from '../middleware/crmAuth.middleware';
import dayPulseController from '../controllers/Daypulse.controller';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';
import { RequestHandler } from 'express';

const router = Router();
const MAX_DAYPULSE_ATTACHMENTS = 5;
const MAX_DAYPULSE_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
const DAYPULSE_ATTACHMENT_FIELDS = [
    { name: 'attachmentsAccomplishment', maxCount: MAX_DAYPULSE_ATTACHMENTS },
    { name: 'attachmentsBlockers', maxCount: MAX_DAYPULSE_ATTACHMENTS },
    { name: 'attachmentsInProgress', maxCount: MAX_DAYPULSE_ATTACHMENTS },
];
const ALLOWED_DAYPULSE_ATTACHMENT_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const ALLOWED_DAYPULSE_ATTACHMENT_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.pdf',
    '.doc',
    '.docx',
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_DAYPULSE_ATTACHMENT_SIZE_BYTES,
        files: MAX_DAYPULSE_ATTACHMENTS * DAYPULSE_ATTACHMENT_FIELDS.length,
    },
    fileFilter: (_req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const mimeAllowed = ALLOWED_DAYPULSE_ATTACHMENT_MIME_TYPES.has(file.mimetype);
        const extAllowed = ALLOWED_DAYPULSE_ATTACHMENT_EXTENSIONS.has(extension);

        if (mimeAllowed || extAllowed) {
            cb(null, true);
            return;
        }

        cb(new ApiError(400, 'Only images, PDF files, and DOCX files are allowed for DayPulse attachments.') as any, false);
    },
});

const parseAttachments: RequestHandler = (req, res, next) => {
    if (!req.is('multipart/form-data')) {
        return next();
    }

    upload.fields(DAYPULSE_ATTACHMENT_FIELDS)(req, res, (err: any) => {
        if (!err) return next();

        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return next(new ApiError(400, 'Each attachment must be 25 MB or smaller.'));
            }

            if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                return next(new ApiError(400, `You can attach up to ${MAX_DAYPULSE_ATTACHMENTS} files per section.`));
            }

            return next(new ApiError(400, err.message));
        }

        return next(new ApiError(400, err?.message || 'Failed to process DayPulse attachments.'));
    });
};

// All DayPulse routes require CRM authentication
router.use(crmAuth());

// ── Report dates (must come before /:id to avoid route conflict) ──
router.get('/dates', dayPulseController.getReportDates);

// ── Core CRUD ──
router.get('/', dayPulseController.getReports);
router.post('/', uploadLimiter, parseAttachments, dayPulseController.createReport);
router.put('/:id', dayPulseController.updateReport);
router.delete('/:id', dayPulseController.deleteReport);

export default router;