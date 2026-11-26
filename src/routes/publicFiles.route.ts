import express, { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { openSharedFile } from '../services/textMedia.service';

const router = express.Router();

router.get('/:token', asyncHandler(async (req: Request, res: Response) => {
  const opened = await openSharedFile(String(req.params.token || ''));
  if (!opened) {
    res.status(404).type('text/plain').send('This file is no longer available.');
    return;
  }
  res.setHeader('Content-Type', opened.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(opened.name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  opened.stream.pipe(res);
}));

export default router;
