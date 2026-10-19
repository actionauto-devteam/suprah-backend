import express from 'express';
import request from 'supertest';

const mockStorageUpload = jest.fn();

jest.mock('../../src/middleware/crmAuth.middleware', () => ({
  __esModule: true,
  default: () => (req: any, _res: any, next: any) => {
    req.orgId = 'org-1';
    req.crmUser = { _id: 'user-1', role: 'admin' };
    next();
  },
}));
jest.mock('../../src/middleware/rate-limit.middleware', () => ({
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../src/services/storage.service', () => ({
  __esModule: true,
  default: { upload: mockStorageUpload },
  BucketType: { PUBLIC: 'public', PRIVATE: 'private' },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import emailCampaignRoutes, { EMAIL_CAMPAIGN_IMAGE_MAX_BYTES } from '../../src/routes/emailCampaign.routes';

const app = express();
app.use('/api/crm/email-campaigns', emailCampaignRoutes);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

const upload = (buffer: Buffer, filename: string, contentType: string) =>
  request(app).post('/api/crm/email-campaigns/images').attach('image', buffer, { filename, contentType });

describe('POST /api/crm/email-campaigns/images', () => {
  beforeEach(() => {
    mockStorageUpload.mockReset();
    mockStorageUpload.mockResolvedValue('https://cdn.example.com/email-campaigns/org-1/photo.png');
  });

  it('accepts a PNG from the device and returns its public url', async () => {
    const res = await upload(PNG_BYTES, 'photo.png', 'image/png');
    expect(res.status).toBe(201);
    expect(res.body.data.url).toBe('https://cdn.example.com/email-campaigns/org-1/photo.png');
    expect(mockStorageUpload).toHaveBeenCalledTimes(1);
  });

  it('accepts a JPEG from the device', async () => {
    const res = await upload(JPEG_BYTES, 'photo.jpg', 'image/jpeg');
    expect(res.status).toBe(201);
  });

  it('rejects images larger than 5 MB with a friendly message', async () => {
    const big = Buffer.concat([JPEG_BYTES, Buffer.alloc(EMAIL_CAMPAIGN_IMAGE_MAX_BYTES)]);
    const res = await upload(big, 'huge.jpg', 'image/jpeg');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Images must be 5 MB or smaller');
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('ignores file types that are not images', async () => {
    const res = await upload(Buffer.from('%PDF-1.4 fake'), 'doc.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('rejects a renamed file whose contents do not match its image type', async () => {
    const res = await upload(Buffer.from('not really an image at all'), 'fake.png', 'image/png');
    expect(res.status).toBe(400);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });
});
