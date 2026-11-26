import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import CrmUser from '../src/models/CrmUser.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import crmRoute from '../src/routes/crm.route';

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const org = new mongoose.Types.ObjectId();
const ana = new mongoose.Types.ObjectId();
const ben = new mongoose.Types.ObjectId();
const tokens: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

describe('Real-DB proof: each CRM user keeps their own quick action order (local MongoDB only)', () => {
  beforeAll(async () => {
    const crm = (_id: mongoose.Types.ObjectId, fullName: string, role: string) => ({ _id, organizationId: org, fullName, username: `u-${_id}`, email: `${fullName.toLowerCase()}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([crm(ana, 'Ana', 'employee'), crm(ben, 'Ben', 'admin')] as any[]);
    tokens.ana = generateCrmToken(String(ana));
    tokens.ben = generateCrmToken(String(ben));
  });

  it('starts with no saved order', async () => {
    const res = await request(app).get('/api/crm/me/quick-actions').set(as('ana'));
    expect(res.status).toBe(200);
    expect(res.body.data.order).toEqual([]);
  });

  it('saves the order for that user only', async () => {
    const saved = await request(app).put('/api/crm/me/quick-actions').set(as('ana')).send({ order: ['settings', 'leads', 'reports', 'leads'] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.order).toEqual(['settings', 'leads', 'reports']);

    expect((await request(app).get('/api/crm/me/quick-actions').set(as('ana'))).body.data.order).toEqual(['settings', 'leads', 'reports']);
    expect((await request(app).get('/api/crm/me/quick-actions').set(as('ben'))).body.data.order).toEqual([]);

    const stored: any = await CrmUser.collection.findOne({ _id: ben });
    expect(stored.quickActionOrder).toBeUndefined();
  });

  it('refuses a bad list and keeps the saved order', async () => {
    for (const body of [{}, { order: 'leads' }, { order: ['Leads!'] }, { order: [42] }, { order: Array.from({ length: 41 }, (_, i) => `a-${i}`) }]) {
      const res = await request(app).put('/api/crm/me/quick-actions').set(as('ana')).send(body);
      expect(res.status).toBe(400);
    }
    expect((await request(app).get('/api/crm/me/quick-actions').set(as('ana'))).body.data.order).toEqual(['settings', 'leads', 'reports']);
  });

  it('goes back to the default order when an empty list is saved', async () => {
    const res = await request(app).put('/api/crm/me/quick-actions').set(as('ana')).send({ order: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.order).toEqual([]);
    const stored: any = await CrmUser.collection.findOne({ _id: ana });
    expect(stored.quickActionOrder).toBeUndefined();
  });

  it('needs a signed-in CRM user', async () => {
    expect((await request(app).get('/api/crm/me/quick-actions')).status).toBe(401);
    expect((await request(app).put('/api/crm/me/quick-actions').send({ order: ['leads'] })).status).toBe(401);
  });
});
