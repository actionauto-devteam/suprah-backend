/**
 * Batch A, security (2026-11-17): Garage photos and profile pictures can only
 * delete files this server stored for them, the storage delete never leaves
 * the uploads folder or the bucket's folders, and Inventory / Create Load
 * searches treat typed text literally.
 */
import fs from 'fs';
import path from 'path';

const mockFindOne = jest.fn();
const mockExists = jest.fn();
jest.mock('../../src/models/OwnedVehicle.model', () => ({
  OwnedVehicle: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    exists: (...args: unknown[]) => mockExists(...args),
  },
}));

const mockUpload = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../src/services/storage.service', () => {
  const service = {
    upload: (...args: unknown[]) => mockUpload(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  };
  return { __esModule: true, default: service, storageService: service, BucketType: { PUBLIC: 'public', PRIVATE: 'private' } };
});

const mockUpdateProfile = jest.fn();
jest.mock('../../src/services/profile.service', () => ({
  __esModule: true,
  default: { updateProfile: (...args: unknown[]) => mockUpdateProfile(...args) },
}));

const mockUserFindById = jest.fn();
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findById: (...args: unknown[]) => mockUserFindById(...args) },
}));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn() }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitPresenceUpdate: jest.fn() }));

import { isSafeStorageKey, localUploadPath } from '../../src/utils/storageKeyGuard';
import { isStoredUpload } from '../../src/utils/storedUpload';
import { containsText, queryText } from '../../src/services/marketplaceQuery';
import { updateOwnedVehicle, uploadOwnedVehicleImage } from '../../src/controllers/ownedVehicle.controller';
import profileController from '../../src/controllers/profile.controller';

const source = (rel: string) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');

/** Runs an Express handler and resolves with what it answered (or the error it passed on). */
function call(handler: any, req: any): Promise<{ status: number; body: any; error?: any }> {
  return new Promise((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (body: any) => { resolve({ status: res.statusCode, body }); return res; };
    handler(req, res, (error: any) => resolve({ status: error?.statusCode ?? 500, body: null, error }));
  });
}

const garageCar = (images: string[]) => ({
  _id: 'car-1',
  images: [...images],
  color: 'Blue',
  currentMileage: 1000,
  save: jest.fn(async () => undefined),
  toObject() { return { images: this.images, color: this.color }; },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUpload.mockResolvedValue('/uploads/vehicles/1700000000999-42.png');
  mockDelete.mockResolvedValue(undefined);
  mockExists.mockResolvedValue(null);
});

describe('storage delete guard', () => {
  const root = path.resolve('/srv/app');

  it('allows files inside the uploads folder', () => {
    expect(localUploadPath('/uploads/vehicles/1700000000000-1.png', root)).toBe(path.join(root, 'uploads', 'vehicles', '1700000000000-1.png'));
  });

  it('refuses paths that climb out of the uploads folder', () => {
    expect(localUploadPath('/uploads/../package.json', root)).toBeNull();
    expect(localUploadPath('/uploads/vehicles/../../.env', root)).toBeNull();
    expect(localUploadPath('/uploads/a\\..\\..\\b', root)).toBeNull();
    expect(localUploadPath('/etc/passwd', root)).toBeNull();
  });

  it('allows only plain bucket keys', () => {
    expect(isSafeStorageKey('avatars/1700000000000-12.png')).toBe(true);
    expect(isSafeStorageKey('email-campaigns/org1/1700000000000-12.png')).toBe(true);
    for (const key of ['', '../x', 'a/../b', '/avatars/x.png', 'a//b', 'a\\b', 'a/./b', 'avatars/x.png\n']) {
      expect(isSafeStorageKey(key)).toBe(false);
    }
  });

  it('is used by the storage delete', () => {
    const storage = source('src/services/storage.service.ts');
    expect(storage).toMatch(/localUploadPath\(pathOrUrl, path\.join\(__dirname, '\.\.\/\.\.\/'\)\)/);
    expect(storage).toMatch(/if \(!isSafeStorageKey\(key\)\)/);
    expect(storage).not.toMatch(/path\.join\(__dirname, '\.\.\/\.\.\/', pathOrUrl\)/);
  });
});

describe('files this server stored', () => {
  const cdn = 'https://cdn.example.com';

  it('recognises an upload in its folder as a URL, a local copy or a key', () => {
    expect(isStoredUpload(`${cdn}/vehicles/1700000000000-123.jpg`, 'vehicles', cdn)).toBe(true);
    expect(isStoredUpload('/uploads/vehicles/1700000000000-123.jpg', 'vehicles', cdn)).toBe(true);
    expect(isStoredUpload('vehicles/1700000000000-123.jpg', 'vehicles', cdn)).toBe(true);
  });

  it('never treats anything else as ours to delete', () => {
    for (const value of [
      `${cdn}/avatars/1700000000000-123.jpg`,
      'https://photos.dealer.example.com/vehicles/1700000000000-123.jpg',
      '/uploads/vehicles/../../package.json',
      'vehicles/my-car.jpg',
      `${cdn}/vehicles/1700000000000-123.jpg?x=1`,
      'javascript:alert(1)',
      '',
    ]) {
      expect(isStoredUpload(value, 'vehicles', cdn)).toBe(false);
    }
    expect(isStoredUpload(42, 'vehicles', cdn)).toBe(false);
    expect(isStoredUpload(['vehicles/1700000000000-123.jpg'], 'vehicles', cdn)).toBe(false);
  });
});

describe('Garage photos', () => {
  it('ignores a photo list sent with an edit', async () => {
    const car = garageCar(['/uploads/vehicles/1700000000000-1.png']);
    mockFindOne.mockResolvedValue(car);
    const result = await call(updateOwnedVehicle, {
      user: { _id: 'customer-1' },
      params: { id: 'car-1' },
      body: { color: 'Red', images: ['/uploads/../package.json'] },
    });
    expect(result.status).toBe(200);
    expect(car.images).toEqual(['/uploads/vehicles/1700000000000-1.png']);
    expect(car.color).toBe('Red');
    expect(car.save).toHaveBeenCalled();
  });

  it('deletes the old Garage photo only after the new one is saved', async () => {
    const car = garageCar(['/uploads/vehicles/1700000000000-1.png', '/uploads/vehicles/1700000000000-2.png']);
    mockFindOne.mockResolvedValue(car);
    const result = await call(uploadOwnedVehicleImage, {
      user: { _id: 'customer-1' },
      params: { id: 'car-1' },
      file: { originalname: 'car.png', mimetype: 'image/png', buffer: Buffer.from('x') },
    });
    expect(result.status).toBe(200);
    expect(car.images).toEqual(['/uploads/vehicles/1700000000999-42.png', '/uploads/vehicles/1700000000000-2.png']);
    expect(mockUpload).toHaveBeenCalledWith(expect.anything(), 'vehicles');
    expect(mockDelete).toHaveBeenCalledWith('/uploads/vehicles/1700000000000-1.png');
    expect(car.save.mock.invocationCallOrder[0]).toBeLessThan(mockDelete.mock.invocationCallOrder[0]);
  });

  it.each([
    ['a dealership photo copied by Add to garage', 'https://photos.dealer.example.com/car.jpg'],
    ['a path outside the uploads folder', '/uploads/../package.json'],
    ['another feature\'s file', 'avatars/1700000000000-1.png'],
  ])('never deletes %s', async (_label, previous) => {
    mockFindOne.mockResolvedValue(garageCar([previous]));
    const result = await call(uploadOwnedVehicleImage, {
      user: { _id: 'customer-1' },
      params: { id: 'car-1' },
      file: { originalname: 'car.png', mimetype: 'image/png', buffer: Buffer.from('x') },
    });
    expect(result.status).toBe(200);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('keeps a photo another Garage car still uses', async () => {
    mockFindOne.mockResolvedValue(garageCar(['/uploads/vehicles/1700000000000-1.png']));
    mockExists.mockResolvedValue({ _id: 'car-2' });
    await call(uploadOwnedVehicleImage, {
      user: { _id: 'customer-1' },
      params: { id: 'car-1' },
      file: { originalname: 'car.png', mimetype: 'image/png', buffer: Buffer.from('x') },
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('checks that an uploaded photo really is an image', () => {
    expect(source('src/routes/ownedVehicle.route.ts')).toMatch(
      /router\.post\('\/:id\/image', uploadVehicleImage, validateUploadedImageContent, uploadOwnedVehicleImage\);/,
    );
  });
});

describe('profile picture', () => {
  const current = (avatar: string | null) =>
    mockUserFindById.mockReturnValue({ select: () => ({ lean: async () => ({ avatar }) }) });

  beforeEach(() => mockUpdateProfile.mockResolvedValue({ name: 'Maria' }));

  it('can still be cleared, without deleting a file', async () => {
    const result = await call(profileController.updateProfile, { user: { _id: 'u1' }, body: { avatar: null } });
    expect(result.status).toBe(200);
    expect(mockUpdateProfile).toHaveBeenCalledWith('u1', { avatar: null }, undefined);
  });

  it('can be sent back unchanged with other details', async () => {
    current('/uploads/avatars/1700000000000-1.png');
    const result = await call(profileController.updateProfile, {
      user: { _id: 'u1' },
      body: { name: 'Maria', avatar: '/uploads/avatars/1700000000000-1.png' },
    });
    expect(result.status).toBe(200);
    expect(mockUpdateProfile).toHaveBeenCalledWith('u1', { name: 'Maria' }, undefined);
  });

  it('cannot be pointed at another file', async () => {
    current('/uploads/avatars/1700000000000-1.png');
    const result = await call(profileController.updateProfile, {
      user: { _id: 'u1' },
      body: { avatar: 'avatars/1700000000000-999.png' },
    });
    expect(result.status).toBe(400);
    expect(result.error.message).toBe('Change your profile picture with Upload photo, then try again.');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it('is deleted on change, removal or account deletion only when this server stored it', () => {
    const profile = source('src/services/profile.service.ts');
    expect(profile.match(/await deleteOwnProfilePicture\(userId, existingUser\.avatar\);/g)).toHaveLength(2);
    expect(profile).not.toMatch(/storageService\.delete\(existingUser\.avatar\)/);
    expect(profile).toMatch(/if \(!isStoredUpload\(avatar, 'avatars'\)\) return;/);
    const deletion = source('src/services/accountDeletion.service.ts');
    expect(deletion).toMatch(/const avatarIsOurs = isStoredUpload\(avatar, "avatars"\)/);
    expect(deletion).toMatch(/const publicFiles: string\[\] = avatarIsOurs \? \[avatar\] : \[\];/);
  });
});

describe('Inventory and Create Load searches', () => {
  it('match typed text literally', () => {
    const model = containsText('X5 M50i (G05)')!;
    expect(model.test('BMW X5 M50i (G05)')).toBe(true);
    expect(model.test('X5 M50i G05')).toBe(false);
    expect(containsText(['C++', 'other'])!.test('Series C++ edition')).toBe(true);
    expect(containsText('.*')!.test('anything')).toBe(false);
  });

  it('use one plain value, never a query object', () => {
    expect(queryText('  Ready for Sale ')).toBe('Ready for Sale');
    expect(queryText(['In Recon', 'Sold'])).toBe('In Recon');
    expect(queryText({ $ne: 'Sold' })).toBe('');
  });

  it('are used by every Inventory filter, the export, the autocomplete and the Create Load picker', () => {
    const vehicles = source('src/controllers/vehicle.controller.ts');
    expect(vehicles).not.toMatch(/\$regex: (make|model|location|q|req\.query\.[a-zA-Z]+),/);
    expect(vehicles).not.toMatch(/filter\.status = status;/);
    expect(vehicles.match(/const statusText = queryText\(status\);/g)).toHaveLength(2);
    expect(vehicles).toMatch(/const q = queryText\(req\.query\.q\);/);
    const loads = source('src/controllers/load.controller.ts');
    expect(loads).toMatch(/const match = containsText\(queryText\(req\.query\.q\)\.toUpperCase\(\)\);/);
    expect(loads).not.toMatch(/\{ vin: \{ \$regex: q, \$options: "i" \} \}/);
  });
});
