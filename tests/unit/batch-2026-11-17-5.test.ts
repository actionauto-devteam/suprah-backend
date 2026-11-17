/**
 * Batch B, stability (2026-11-17): a driver deleting a document removes only
 * that one, the Inventory export writes safe spreadsheet cells, and the Garage
 * VIN lookup checks its input and doesn't wait forever.
 */
import fs from 'fs';
import path from 'path';

const mockProfileFindOne = jest.fn();
const mockProfileFindOneAndUpdate = jest.fn();
jest.mock('../../src/models/DriverProfile.model', () => {
  const actual = jest.requireActual('../../src/models/DriverProfile.model');
  return {
    __esModule: true,
    ...actual,
    default: {
      findOne: (...args: unknown[]) => mockProfileFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) => mockProfileFindOneAndUpdate(...args),
    },
  };
});

const mockStorageDelete = jest.fn();
jest.mock('../../src/services/storage.service', () => {
  const service = {
    delete: (...args: unknown[]) => mockStorageDelete(...args),
    getKeyFromUrl: (url: string) => url,
  };
  return { __esModule: true, default: service, storageService: service, BucketType: { PUBLIC: 'public', PRIVATE: 'private' } };
});
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { logActivity: jest.fn() } }));
jest.mock('../../src/services/driverVerificationReview.service', () => ({ recordDriverReviewEvent: jest.fn() }));
jest.mock('../../src/services/driverStatusTransition.service', () => ({
  ACTIVE_DRIVER_LOAD_STATUSES: [],
  applyDriverOperationalStatus: jest.fn(),
  finalizeDriverStatusChangeIfClear: jest.fn(),
  getOpenDriverStatusRequest: jest.fn(),
}));
jest.mock('../../src/services/driverReviewNotice', () => ({ notifyDriverReviewers: jest.fn() }));
jest.mock('../../src/services/driverContactSync.service', () => ({ syncVerificationContactToAccount: jest.fn() }));
jest.mock('../../src/services/driverWorkCommitment.service', () => ({ withDriverCommitmentLock: jest.fn() }));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { get: (...args: unknown[]) => mockAxiosGet(...args) } }));
const mockVehicleFindOne = jest.fn();
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockVehicleFindOne(...args) },
}));

import { csvCell, csvRow } from '../../src/utils/csvCell';
import driverProfileController from '../../src/controllers/driverProfile.controller';
import { decodeVin } from '../../src/controllers/ownedVehicle.controller';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockStorageDelete.mockResolvedValue(undefined);
});

describe('driver deletes a document', () => {
  const doc = (id: string, type: string) => ({ _id: { toString: () => id }, type, fileKey: `driver-documents/${id}.pdf`, reviewStatus: 'approved' });
  const profile = (documents: any[]) => ({
    _id: 'profile-1',
    verificationStatus: 'verified',
    documents,
    toObject() { return { _id: this._id, documents: this.documents }; },
  });
  const driver = { _id: 'driver-1', role: 'driver', name: 'Sam' };

  it('removes only that document, in one step', async () => {
    const insurance = doc('d2', 'insurance_certificate');
    mockProfileFindOne.mockResolvedValue(profile([doc('d1', 'drivers_license'), insurance]));
    mockProfileFindOneAndUpdate.mockResolvedValue({ _id: 'profile-1', documents: [doc('d1', 'drivers_license')] });
    const result = await call(driverProfileController.deleteDocument, { user: driver, params: { documentId: 'd2' } });
    expect(result.status).toBe(200);
    const [filter, update] = mockProfileFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'profile-1', 'documents._id': insurance._id });
    expect(update.$pull).toEqual({ documents: { _id: insurance._id } });
    expect(update.$set).toEqual({ isComplianceExpired: false });
    expect(update).not.toHaveProperty('documents');
    expect(mockStorageDelete).toHaveBeenCalledWith('driver-documents/d2.pdf', 'private');
  });

  it('sends the driver back to review when a required document goes', async () => {
    const license = doc('d1', 'drivers_license');
    mockProfileFindOne.mockResolvedValue(profile([license]));
    mockProfileFindOneAndUpdate.mockResolvedValue({ _id: 'profile-1', documents: [] });
    await call(driverProfileController.deleteDocument, { user: driver, params: { documentId: 'd1' } });
    expect(mockProfileFindOneAndUpdate.mock.calls[0][1].$set).toEqual({ isComplianceExpired: false, verificationStatus: 'in_progress' });
  });

  it('says it was already removed when another tab removed it first, keeping the file', async () => {
    mockProfileFindOne.mockResolvedValue(profile([doc('d1', 'drivers_license')]));
    mockProfileFindOneAndUpdate.mockResolvedValue(null);
    const result = await call(driverProfileController.deleteDocument, { user: driver, params: { documentId: 'd1' } });
    expect(result.status).toBe(404);
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('no longer saves the whole profile', () => {
    const controller = source('src/controllers/driverProfile.controller.ts');
    const body = controller.slice(controller.indexOf('const deleteDocument'), controller.indexOf('const updateLogistics'));
    expect(body).not.toMatch(/profile\.documents = /);
    expect(body).not.toMatch(/await profile\.save\(\)/);
  });
});

describe('Inventory export cells', () => {
  it('quotes values with commas, quotes or line breaks', () => {
    expect(csvCell('5.0 "Coyote"')).toBe('"5.0 ""Coyote"""');
    expect(csvCell('Salt Lake City, UT')).toBe('"Salt Lake City, UT"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('opens formulas as plain text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
  });

  it('writes numbers and plain text as they are', () => {
    expect(csvRow(['1HGCM82633A004352', 2024, 'Honda', 23995, null, undefined])).toBe('1HGCM82633A004352,2024,Honda,23995,,');
    expect(csvCell(-5)).toBe('-5');
  });

  it('is used for every exported row', () => {
    const vehicles = source('src/controllers/vehicle.controller.ts');
    expect(vehicles).toMatch(/csvRow\(\[\s*v\.vin,/);
    expect(vehicles).not.toMatch(/`"\$\{v\.vin\}"/);
  });
});

describe('Garage VIN lookup', () => {
  const lookup = (vin: string) => call(decodeVin, { user: { _id: 'customer-1' }, params: { vin } });

  beforeEach(() => {
    mockVehicleFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  });

  it('refuses anything but 17 letters and numbers, without calling the VIN service', async () => {
    for (const vin of ['1HGCM82633A00435/', '1HGCM82633A0043?x', '1HGCM82633A0043 2', '1HGCM']) {
      const result = await lookup(vin);
      expect(result.status).toBe(400);
    }
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('gives the VIN service 8 seconds', async () => {
    mockAxiosGet.mockResolvedValue({ data: { Results: [{ Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] } });
    const result = await lookup('1hgcm82633a004352');
    expect(result.status).toBe(200);
    expect(result.body.data.make).toBe('HONDA');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/1HGCM82633A004352?format=json',
      { timeout: 8000 },
    );
  });

  it('says to try again or type the details when the service is slow', async () => {
    mockAxiosGet.mockRejectedValue(Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }));
    const result = await lookup('1HGCM82633A004352');
    expect(result.status).toBe(503);
    expect(result.error.message).toMatch(/^We couldn't look up this VIN right now\. Try again in a minute, or enter the make, model and year yourself\./);
  });
});
