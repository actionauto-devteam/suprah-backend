const mockSend = jest.fn();
const mockPresign = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) => jest.fn().mockImplementation((input: any) => ({ name, input }));
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    PutObjectCommand: command('Put'),
    DeleteObjectCommand: command('Delete'),
    GetObjectCommand: command('Get'),
    ListObjectsV2Command: command('List'),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mockPresign }));
jest.mock('../../src/config/awsHttpHandler', () => ({ sharedAwsHttpHandler: {} }));
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    r2: {
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      buckets: { public: 'public-bucket', private: 'private-bucket', ftp: 'ftp-bucket' },
      publicUrl: 'https://cdn.example.com',
    },
  },
}));

import fsPromises from 'fs/promises';
import fs from 'fs';
import { StorageService, BucketType } from '../../src/services/storage.service';

const image = { buffer: Buffer.from([0xff, 0xd8, 0xff]), originalname: 'photo.jpg', mimetype: 'image/jpeg' };

describe('R2 storage in local UI acceptance mode', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    mockSend.mockResolvedValue({});
    mockPresign.mockResolvedValue('https://signed.example.com/x');
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = env;
  });

  it('never uploads to R2 and keeps the file on local disk instead', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    const storage = new StorageService();
    const url = await storage.upload(image, 'avatars');
    expect(mockSend).not.toHaveBeenCalled();
    expect(url).toMatch(/^\/uploads\/avatars\//);
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('refuses uploads that must be public in the cloud, such as email campaign images, instead of faking a URL', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    const storage = new StorageService();
    await expect(storage.upload(image, 'email-campaigns/org-1', BucketType.PUBLIC, { allowLocalFallback: false }))
      .rejects.toThrow('local fallback is disabled');
    expect(mockSend).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('never deletes, lists, signs, or streams real R2 objects', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    const storage = new StorageService();
    await storage.delete('https://cdn.example.com/avatars/a.jpg');
    await expect(storage.list('screenshots/')).resolves.toEqual([]);
    await expect(storage.getSignedUrl('private/key.jpg')).resolves.toBeNull();
    await expect(storage.streamPrivateFile('private/key.jpg')).resolves.toBeNull();
    await expect(storage.streamPublicFile('public/key.jpg')).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('still serves files that were saved locally', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    const storage = new StorageService();
    await expect(storage.getSignedUrl('/uploads/avatars/a.jpg')).resolves.toBe('/uploads/avatars/a.jpg');
  });

  it('blocks R2 even if acceptance mode is switched on after the service was created', async () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    const storage = new StorageService();
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    await storage.upload(image, 'avatars');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps production uploads going to R2 with the public URL unchanged', async () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    const storage = new StorageService();
    const url = await storage.upload(image, 'email-campaigns/org-1', BucketType.PUBLIC, { allowLocalFallback: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toMatchObject({ Bucket: 'public-bucket', ContentType: 'image/jpeg' });
    expect(url).toMatch(/^https:\/\/cdn\.example\.com\/email-campaigns\/org-1\//);
  });

  it('keeps production signed URLs and deletes working', async () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    const storage = new StorageService();
    await expect(storage.getSignedUrl('private/key.jpg')).resolves.toBe('https://signed.example.com/x');
    await storage.delete('https://cdn.example.com/avatars/a.jpg');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ name: 'Delete' }));
  });
});
