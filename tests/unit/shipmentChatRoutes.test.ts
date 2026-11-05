/**
 * The routes of the customer chats on a shipment: My Shipments' side is for
 * customer accounts only, messages are rate limited, nothing is cached, and
 * only real photos (JPG, PNG, WebP) can be sent. Controllers are stand-ins so
 * this checks the routes themselves; no database is used.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth.middleware', () => ({
  __esModule: true,
  default: () => (req: any, _res: any, next: any) => {
    req.user = { _id: req.headers['x-test-user'] ?? 'user-1', role: req.headers['x-test-role'] };
    next();
  },
}));
jest.mock('../../src/controllers/quote.controller', () => ({
  __esModule: true,
  default: {
    createCustomerQuoteRequest: (_req: any, res: any) => res.status(201).json({ ok: true }),
    getMyShipments: (_req: any, res: any) => res.status(200).json({ ok: true }),
    getShipmentTracking: (_req: any, res: any) => res.status(200).json({ ok: true }),
    withdrawCustomerQuoteRequest: (_req: any, res: any) => res.status(200).json({ ok: true }),
  },
}));
jest.mock('../../src/controllers/shipmentChat.controller', () => ({
  __esModule: true,
  default: {
    getCustomerChat: (_req: any, res: any) => res.status(200).json({ ok: true }),
    sendCustomerMessage: (_req: any, res: any) => res.status(201).json({ ok: true }),
    sendCustomerPhotos: (req: any, res: any) => res.status(201).json({ photos: (req.files ?? []).map((f: any) => f.mimetype) }),
    markCustomerChatRead: (_req: any, res: any) => res.status(200).json({ ok: true }),
  },
}));

import customerQuoteRequestRoutes from '../../src/routes/customerQuoteRequest.routes';

const app = express();
app.use(express.json());
app.use('/api/quote-requests', customerQuoteRequestRoutes);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.7 fake');

beforeEach(() => {
  process.env.SKIP_RATE_LIMIT = 'false';
});
afterAll(() => {
  delete process.env.SKIP_RATE_LIMIT;
});

describe('the customer side of the chats', () => {
  it('lets a customer open and use a chat, never cached', async () => {
    const open = await request(app).get('/api/quote-requests/q-1/chats/driver').set('x-test-role', 'customer');
    expect(open.status).toBe(200);
    expect(open.headers['cache-control']).toBe('private, no-store, max-age=0');
    const send = await request(app).post('/api/quote-requests/q-1/chats/dispatcher/messages').set('x-test-role', 'customer').send({ content: 'Hi' });
    expect(send.status).toBe(201);
    expect((await request(app).post('/api/quote-requests/q-1/chats/driver/read').set('x-test-role', 'customer')).status).toBe(200);
  });

  it.each(['employee', 'admin', 'driver'])('sends %s accounts to the load instead', async (role) => {
    const res = await request(app).get('/api/quote-requests/q-1/chats/driver').set('x-test-role', role);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This chat is for the customer receiving the vehicle. Staff and drivers open it from the load.');
  });

  it('slows down a customer sending very fast, without blocking others', async () => {
    const send = (user: string) =>
      request(app).post('/api/quote-requests/q-1/chats/driver/messages').set('x-test-role', 'customer').set('x-test-user', user).send({ content: 'Hi' });
    for (let i = 0; i < 30; i += 1) expect((await send('fast-customer')).status).toBe(201);
    const limited = await send('fast-customer');
    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/Wait a minute/);
    expect((await send('other-customer')).status).toBe(201);
  });
});

describe('photos', () => {
  const upload = (name: string, body: Buffer, type: string) =>
    request(app)
      .post('/api/quote-requests/q-1/chats/driver/photos')
      .set('x-test-role', 'customer')
      .attach('photos', body, { filename: name, contentType: type });

  it('accepts a real JPG', async () => {
    const res = await upload('car.jpg', JPEG, 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body.photos).toEqual(['image/jpeg']);
  });

  it('refuses other files, and files pretending to be photos', async () => {
    const pdf = await upload('papers.pdf', PDF, 'application/pdf');
    expect(pdf.status).toBe(400);
    expect(pdf.body.message).toBe("papers.pdf isn't a photo we can send. Send photos as JPG, PNG or WebP.");
    const fake = await upload('car.jpg', PDF, 'image/jpeg');
    expect(fake.status).toBe(400);
    expect(fake.body.message).toBe("car.jpg isn't a real JPG, PNG or WebP photo. Choose another photo.");
  });
});
