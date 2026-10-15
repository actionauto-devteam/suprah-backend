const mockFind = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { r2: { buckets: { private: 'suprah-private' } } },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/services/storage.service', () => ({
  storageService: { delete: mockDelete },
  BucketType: { PRIVATE: 'private', PUBLIC: 'public' },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { find: mockFind },
}));

import {
  collectLoadPhotoKeys,
  deletePhotosOfDeletedLoad,
  isStoredPhotoKey,
  keyFromSignedPhotoUrl,
  restoreInspectionPhotoKeys,
} from '../../src/services/loadPhotoStorage.service';

const signed = (path: string) =>
  `https://account.r2.cloudflarestorage.com/${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abc123`;

describe('photo storage keys', () => {
  it('tells stored keys apart from links', () => {
    expect(isStoredPhotoKey('load-inspection/a.jpg')).toBe(true);
    expect(isStoredPhotoKey('/uploads/a.jpg')).toBe(true);
    expect(isStoredPhotoKey('https://example.com/a.jpg')).toBe(false);
    expect(isStoredPhotoKey('data:image/png;base64,AAA')).toBe(false);
    expect(isStoredPhotoKey('')).toBe(false);
    expect(isStoredPhotoKey(undefined)).toBe(false);
  });

  it('reads the storage key back out of a signed link to the private bucket', () => {
    expect(keyFromSignedPhotoUrl(signed('suprah-private/load-inspection/a%20b.jpg'))).toBe('load-inspection/a b.jpg');
    expect(keyFromSignedPhotoUrl(signed('load-inspection/c.jpg'))).toBe('load-inspection/c.jpg');
    // Not one of our signed links: left alone.
    expect(keyFromSignedPhotoUrl('https://cdn.example.com/inventory/car.jpg')).toBeNull();
    expect(keyFromSignedPhotoUrl('load-inspection/a.jpg')).toBeNull();
  });

  it('stores keys, not expiring links, when an edited load is saved', () => {
    const existing = [{ inspectionPhotoUrl: 'load-inspection/a.jpg' }, { inspectionPhotoUrl: 'load-inspection/b.jpg' }];
    const incoming = [
      { vin: '1', inspectionPhotoUrl: signed('suprah-private/load-inspection/b.jpg') },
      { vin: '2', inspectionPhotoUrl: 'load-inspection/a.jpg' },
      { vin: '3', inspectionPhotoUrl: 'https://cdn.example.com/other.jpg' },
      { vin: '4' },
    ];
    expect(restoreInspectionPhotoKeys(incoming, existing)).toEqual([
      { vin: '1', inspectionPhotoUrl: 'load-inspection/b.jpg' },
      { vin: '2', inspectionPhotoUrl: 'load-inspection/a.jpg' },
      { vin: '3', inspectionPhotoUrl: 'https://cdn.example.com/other.jpg' },
      { vin: '4' },
    ]);
  });

  it("collects every photo on a load, including earlier drivers' proofs, once each", () => {
    expect(
      collectLoadPhotoKeys({
        proofOfPickup: { imageUrl: 'proof-of-pickup/p.jpg' },
        proofOfDelivery: { imageUrl: 'proof-of-delivery/d.jpg' },
        vehicles: [{ inspectionPhotoUrl: 'load-inspection/i.jpg' }, { inspectionPhotoUrl: 'https://x.test/link' }],
        conditionReports: [{ photos: [{ key: 'condition-report/c1.jpg' }, { key: 'condition-report/c2.jpg' }] }],
        assignmentHistory: [{ proofOfPickup: { imageUrl: 'proof-of-pickup/old.jpg' }, proofOfDelivery: { imageUrl: 'proof-of-delivery/d.jpg' } }],
      }).sort(),
    ).toEqual([
      'condition-report/c1.jpg',
      'condition-report/c2.jpg',
      'load-inspection/i.jpg',
      'proof-of-delivery/d.jpg',
      'proof-of-pickup/old.jpg',
      'proof-of-pickup/p.jpg',
    ]);
  });
});

describe('deletePhotosOfDeletedLoad', () => {
  const findReturns = (loads: unknown[]) =>
    mockFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(loads) }) });

  beforeEach(() => {
    mockFind.mockReset();
    mockDelete.mockReset().mockResolvedValue(undefined);
  });

  it('removes the photos, but keeps one another load still uses', async () => {
    findReturns([{ vehicles: [{ inspectionPhotoUrl: 'load-inspection/shared.jpg' }] }]);
    await expect(
      deletePhotosOfDeletedLoad(['load-inspection/shared.jpg', 'proof-of-pickup/p.jpg'], 'load-1'),
    ).resolves.toBe(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('proof-of-pickup/p.jpg', 'private');
  });

  it('never fails the delete when storage has a problem', async () => {
    findReturns([]);
    mockDelete.mockRejectedValueOnce(new Error('storage down')).mockResolvedValue(undefined);
    await expect(deletePhotosOfDeletedLoad(['a.jpg', 'b.jpg'], 'load-1')).resolves.toBe(1);
    mockFind.mockImplementation(() => {
      throw new Error('database down');
    });
    await expect(deletePhotosOfDeletedLoad(['a.jpg'], 'load-1')).resolves.toBe(0);
  });

  it('does nothing for a load without photos', async () => {
    await expect(deletePhotosOfDeletedLoad([], 'load-1')).resolves.toBe(0);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
