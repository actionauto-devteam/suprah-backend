const mockStorageUpload = jest.fn();

jest.mock('../../src/services/storage.service', () => ({
  __esModule: true,
  default: { upload: mockStorageUpload },
  BucketType: { PUBLIC: 'public', PRIVATE: 'private' },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { uploadCampaignImage } from '../../src/controllers/emailCampaign.controller';

async function invoke(req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  uploadCampaignImage(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next };
}

function imageFile() {
  return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), originalname: 'banner.jpg', mimetype: 'image/jpeg', size: 4 };
}

function req(overrides: Record<string, any> = {}) {
  return {
    orgId: 'org-1',
    crmUser: { _id: 'user-1', role: 'admin' },
    file: imageFile(),
    ...overrides,
  };
}

describe('uploadCampaignImage', () => {
  beforeEach(() => {
    mockStorageUpload.mockReset();
  });

  it('uploads to the public bucket and returns the https url', async () => {
    mockStorageUpload.mockResolvedValue('https://cdn.example.com/email-campaigns/org-1/banner.jpg');
    const { status, json, next } = await invoke(req());
    expect(next).not.toHaveBeenCalled();
    expect(mockStorageUpload).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'banner.jpg' }),
      'email-campaigns/org-1',
      'public',
      { allowLocalFallback: false },
    );
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].data).toEqual({ url: 'https://cdn.example.com/email-campaigns/org-1/banner.jpg' });
  });

  it('rejects non-admin users', async () => {
    const { next } = await invoke(req({ crmUser: { _id: 'user-2', role: 'employee' } }));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    const { next } = await invoke(req({ crmUser: undefined }));
    expect(next.mock.calls[0][0].statusCode).toBe(401);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('rejects a request with no file', async () => {
    const { next } = await invoke(req({ file: undefined }));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('rejects an empty file buffer', async () => {
    const { next } = await invoke(req({ file: { ...imageFile(), buffer: Buffer.alloc(0) } }));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it('returns a friendly 502 when storage fails', async () => {
    mockStorageUpload.mockRejectedValue(new Error('R2 down'));
    const { next } = await invoke(req());
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(502);
    expect(err.message).not.toMatch(/R2 down/);
  });

  it('refuses a non-https url so a localhost link is never emailed', async () => {
    mockStorageUpload.mockResolvedValue('http://localhost:5000/uploads/banner.jpg');
    const { next, status } = await invoke(req());
    expect(next.mock.calls[0][0].statusCode).toBe(500);
    expect(status).not.toHaveBeenCalled();
  });
});
