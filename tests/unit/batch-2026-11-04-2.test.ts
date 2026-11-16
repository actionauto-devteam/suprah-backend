// Tests from the November 4, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from customerPhoto.test.ts
jest.mock('../../src/services/storage.service', () => ({
  __esModule: true,
  default: { streamPublicFile: (key: string) => streamPublicFile(key) },
}));

// Fakes from forSaleCarsOnly.test.ts
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: {
    findOne: (query: unknown) => {
      mockFindOne(query);
      const chain: any = { select: () => Promise.resolve(null), populate: () => Promise.resolve(null) };
      return chain;
    },
    findById: (id: unknown) => Promise.resolve(mockFindById(id)),
  },
}));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), invalidateByPrefix: jest.fn() } }));

// Used by the fakes from forSaleCarsOnly.test.ts (above the imports, as in that file)
const mockFindOne = jest.fn();
const mockFindById = jest.fn();

import { createLoadSchema, updateLoadSchema } from '../../src/validations/load.validation';
import { Readable } from 'stream';
import express from 'express';
import request from 'supertest';
import { customerPhotoKey } from '../../src/services/customerPhoto';
import vehicleController from '../../src/controllers/vehicle.controller';
import { resolveLeadContext } from '../../src/middleware/leadContext.middleware';
import { isOnMarketplace, VEHICLE_NOT_FOR_SALE } from '../../src/utils/marketplaceVehicle';

// Used by the fakes from customerPhoto.test.ts
const streamPublicFile = jest.fn();

describe('soldOnDelivery.test.ts', () => {
  /**
   * Create Managed Load asks whether the car is sold to the person receiving
   * it. The answer is optional (older forms and loads without stock cars leave
   * it out), must be a yes or no, and can be changed while editing the load.
   */
  const goodLoad = {
    postType: 'load-board',
    pickupLocation: { address: '1 Main St', city: 'Ogden', state: 'UT', zip: '84401' },
    deliveryLocation: { address: '2 Elm St', city: 'Boise', state: 'ID', zip: '83702' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
  };

  describe('soldOnDelivery', () => {
    it('is accepted as yes or no when creating a load, and can be left out', () => {
      expect(createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: true }).success).toBe(true);
      expect(createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: false }).success).toBe(true);
      expect(createLoadSchema.safeParse(goodLoad).success).toBe(true);
      const parsed: any = createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: true });
      expect(parsed.data.soldOnDelivery).toBe(true);
    });

    it('refuses anything that is not a yes or no', () => {
      const parsed = createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: 'yes' });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0].message).toBe('Choose whether the car is sold to the person receiving it.');
    });

    it('can be changed while editing a load', () => {
      const edit = { soldOnDelivery: true, expectedUpdatedAt: new Date().toISOString() };
      expect(updateLoadSchema.safeParse(edit).success).toBe(true);
    });
  });
});

describe('customerPhoto.test.ts', () => {
  /**
   * Customer photos load through the backend: only the customer photo folders,
   * only file names in the format uploads create, and always as an image.
   */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const photoRoute = require('../../src/routes/customerPhoto.route').default;

  const app = express();
  app.use('/api/photos', photoRoute);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode || 500).json({ message: error.message });
  });

  describe('GET /api/photos/:folder/:file', () => {
    beforeEach(() => streamPublicFile.mockReset());

    it('streams the photo as an image, whatever type was stored with it', async () => {
      streamPublicFile.mockResolvedValue({ stream: Readable.from([Buffer.from('jpg-bytes')]), contentType: 'text/html' });
      const res = await request(app).get('/api/photos/auction-listings/1730000000000-42.jpg');
      expect(streamPublicFile).toHaveBeenCalledWith('auction-listings/1730000000000-42.jpg');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
      expect(res.headers['cache-control']).toContain('public');
    });

    it('answers not found for other folders and names without asking storage', async () => {
      const res = await request(app).get('/api/photos/avatars/1730000000000-1.jpg');
      expect(res.status).toBe(404);
      expect(streamPublicFile).not.toHaveBeenCalled();
    });

    it('answers not found when the photo is missing from storage', async () => {
      streamPublicFile.mockResolvedValue(null);
      const res = await request(app).get('/api/photos/vehicles/1730000000000-1.png');
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("We couldn't find this photo.");
    });
  });

  describe('customer photo requests', () => {
    it('maps each customer photo folder to its bucket folder', () => {
      expect(customerPhotoKey('vehicles', '1730000000000-123456789.jpg')).toEqual({
        key: 'vehicles/1730000000000-123456789.jpg',
        contentType: 'image/jpeg',
      });
      expect(customerPhotoKey('auction-listings', '1730000000000-42.webp')).toEqual({
        key: 'auction-listings/1730000000000-42.webp',
        contentType: 'image/webp',
      });
      expect(customerPhotoKey('aftermarket-media', '1730000000000-7.PNG')).toEqual({
        key: 'aftermarket/media/1730000000000-7.PNG',
        contentType: 'image/png',
      });
    });

    it('serves nothing outside the customer photo folders', () => {
      expect(customerPhotoKey('avatars', '1730000000000-1.jpg')).toBeNull();
      expect(customerPhotoKey('concern-attachments', '1730000000000-1.jpg')).toBeNull();
      expect(customerPhotoKey('constructor', '1730000000000-1.jpg')).toBeNull();
      expect(customerPhotoKey('__proto__', '1730000000000-1.jpg')).toBeNull();
    });

    it('only accepts photo names in the upload format', () => {
      expect(customerPhotoKey('vehicles', '../avatars/1730000000000-1.jpg')).toBeNull();
      expect(customerPhotoKey('vehicles', '1730000000000-1.jpg/../x')).toBeNull();
      expect(customerPhotoKey('vehicles', 'photo.jpg')).toBeNull();
      expect(customerPhotoKey('vehicles', '1730000000000-1.html')).toBeNull();
      expect(customerPhotoKey('aftermarket-media', '1730000000000-1.mp4')).toBeNull();
      expect(customerPhotoKey('vehicles', '')).toBeNull();
    });
  });
});

describe('forSaleCarsOnly.test.ts', () => {
  /**
   * Signed-out visitors and customers only reach cars on the marketplace: the
   * public car page, questions to the dealership and finance applications.
   * Staff keep working with their own cars in every status. The model is a
   * stand-in; no database is used.
   */
  const CAR = '64b0000000000000000000a1';

  function run(handler: any, req: any) {
    return new Promise<{ status?: number; message?: string; passed?: boolean }>((resolve) => {
      const res: any = { status() { return this; }, json() { resolve({ status: 200 }); return this; } };
      handler(req, res, (error: any) => resolve(error ? { status: error.statusCode, message: error.message } : { passed: true }));
    });
  }

  const car = (overrides: Record<string, unknown> = {}) => ({
    _id: CAR,
    organizationId: 'org-1',
    status: 'Ready for Sale',
    isArchived: false,
    isDeleted: false,
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  describe('the public car page', () => {
    it('only looks up cars on the marketplace', async () => {
      const result = await run((vehicleController as any).getPublicVehicleById, { params: { id: CAR } });
      expect(result.status).toBe(404);
      expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
    });
  });

  describe('questions and finance applications', () => {
    const ask = (user: Record<string, unknown>) =>
      run(resolveLeadContext, { body: { vehicleId: CAR }, user });

    it('lets a customer ask about a car that is for sale, routed to its dealership', async () => {
      mockFindById.mockReturnValue(car());
      const req: any = { body: { vehicleId: CAR }, user: { role: 'customer', organizationId: 'org-2' } };
      expect(await run(resolveLeadContext, req)).toEqual({ passed: true });
      expect(req.leadContext.organizationId).toBe('org-1');
    });

    it("refuses a customer's question about a car that isn't for sale", async () => {
      for (const notForSale of [car({ status: 'In Recon' }), car({ status: 'Sold' }), car({ isArchived: true })]) {
        mockFindById.mockReturnValue(notForSale);
        expect(await ask({ role: 'customer' })).toEqual({ status: 404, message: VEHICLE_NOT_FOR_SALE });
      }
    });

    it("still lets staff work with their own dealership's cars in any status", async () => {
      mockFindById.mockReturnValue(car({ status: 'In Recon' }));
      expect(await ask({ role: 'admin', organizationId: 'org-1' })).toEqual({ passed: true });
    });
  });

  describe('isOnMarketplace', () => {
    it('is true only for Ready for Sale cars that are not archived or deleted', () => {
      expect(isOnMarketplace(car())).toBe(true);
      expect(isOnMarketplace(car({ status: 'In Transit' }))).toBe(false);
      expect(isOnMarketplace(car({ isArchived: true }))).toBe(false);
      expect(isOnMarketplace(car({ isDeleted: true }))).toBe(false);
      expect(isOnMarketplace(null)).toBe(false);
    });
  });
});
