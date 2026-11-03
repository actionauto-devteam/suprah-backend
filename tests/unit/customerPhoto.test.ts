/**
 * Customer photos load through the backend: only the customer photo folders,
 * only file names in the format uploads create, and always as an image.
 */
import { Readable } from 'stream';
import express from 'express';
import request from 'supertest';
import { customerPhotoKey } from '../../src/services/customerPhoto';

const streamPublicFile = jest.fn();
jest.mock('../../src/services/storage.service', () => ({
  __esModule: true,
  default: { streamPublicFile: (key: string) => streamPublicFile(key) },
}));

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
