import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  DRIVER_DOCUMENT_UPLOADS_PER_WINDOW,
  driverDocumentUploadLimit,
} from '../../src/middleware/driverDocumentUploadLimit';

// A tiny app with the limit in front of a fake upload, signed in as the driver in x-user.
function uploadApp(approved: boolean) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { _id: req.header('x-user'), role: 'driver', isApproved: approved };
    next();
  });
  app.post('/documents', driverDocumentUploadLimit, (_req, res) => { res.json({ ok: true }); });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
  return app;
}

describe('driver document upload limit', () => {
  const skip = process.env.SKIP_RATE_LIMIT;
  beforeEach(() => { delete process.env.SKIP_RATE_LIMIT; });
  afterAll(() => { if (skip === undefined) delete process.env.SKIP_RATE_LIMIT; else process.env.SKIP_RATE_LIMIT = skip; });

  it('lets an approved driver upload 20 documents in 10 minutes, then says what to do', async () => {
    const app = uploadApp(true);
    for (let i = 0; i < DRIVER_DOCUMENT_UPLOADS_PER_WINDOW; i++) {
      await request(app).post('/documents').set('x-user', 'driver-a').expect(200);
    }
    const blocked = await request(app).post('/documents').set('x-user', 'driver-a').expect(429);
    expect(blocked.body.message).toBe(
      "You've uploaded a lot of documents in the last few minutes. Wait 10 minutes, then upload the rest. If this keeps happening, contact Suprah AI support at support@suprahai.com.",
    );
    // Another driver isn't affected.
    await request(app).post('/documents').set('x-user', 'driver-b').expect(200);
  });

  it("doesn't limit a driver still finishing their application", async () => {
    const app = uploadApp(false);
    for (let i = 0; i < DRIVER_DOCUMENT_UPLOADS_PER_WINDOW + 5; i++) {
      await request(app).post('/documents').set('x-user', 'applicant').expect(200);
    }
  });

  it('is the limit on both document upload routes', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/driverProfile.routes.ts'), 'utf8');
    expect(routes.match(/driverDocumentUploadLimit,/g)).toHaveLength(2);
    expect(routes).not.toContain('driverDocumentUploadLimiter');
  });
});
