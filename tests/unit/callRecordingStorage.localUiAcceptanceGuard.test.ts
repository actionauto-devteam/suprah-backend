const s3SendMock = jest.fn();
const fetchMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: s3SendMock })),
    PutObjectCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Put', input })),
    GetObjectCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Get', input })),
    DeleteObjectCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Delete', input })),
    HeadObjectCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Head', input })),
  };
});

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    r2: {
      endpoint: 'https://example.r2.cloudflarestorage.com',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      buckets: { private: 'recordings-private', public: 'assets-public' },
    },
  },
}));

import {
  importRecordingFile,
  streamRecordingFile,
  deleteRecordingFile,
} from '../../src/services/callRecordingStorage.service';

function resetLocalUiAcceptanceMode() {
  delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
}

describe('LOCAL_UI_ACCEPTANCE_MODE guard for call-recording storage (R2)', () => {
  beforeEach(() => {
    s3SendMock.mockReset();
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
    resetLocalUiAcceptanceMode();
  });

  afterAll(() => {
    resetLocalUiAcceptanceMode();
  });

  describe('streamRecordingFile', () => {
    it('blocks and never constructs an S3 client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(streamRecordingFile('call-recordings/abc.mp3')).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(s3SendMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      s3SendMock.mockResolvedValueOnce({ Body: 'stream', ContentLength: 10, ContentRange: undefined, ContentType: 'audio/mpeg' });
      const result = await streamRecordingFile('call-recordings/abc.mp3');
      expect(s3SendMock).toHaveBeenCalledTimes(1);
      expect(result.length).toBe(10);
    });
  });

  describe('importRecordingFile', () => {
    it('blocks before even downloading from the provider when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(importRecordingFile('https://s3.amazonaws.com/bucket/file.mp3', 'call-recordings/abc.mp3')).rejects.toThrow(
        /LOCAL_UI_ACCEPTANCE_MODE/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(s3SendMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      const body = Buffer.from('fake-audio-bytes');
      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: (async function* () {
          yield body;
        })(),
      });
      s3SendMock
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ ContentLength: body.length });
      const result = await importRecordingFile('https://s3.amazonaws.com/bucket/file.mp3', 'call-recordings/abc.mp3');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(s3SendMock).toHaveBeenCalledTimes(2);
      expect(result.bytes).toBe(body.length);
    });
  });

  describe('deleteRecordingFile (covered as a side effect of guarding the shared client() choke point)', () => {
    it('blocks and never constructs an S3 client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(deleteRecordingFile('call-recordings/abc.mp3')).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(s3SendMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      s3SendMock.mockResolvedValueOnce({});
      await deleteRecordingFile('call-recordings/abc.mp3');
      expect(s3SendMock).toHaveBeenCalledTimes(1);
    });
  });
});
