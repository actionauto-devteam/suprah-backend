import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import crmRoute from '../src/routes/crm.route';
import webchatRoute from '../src/routes/webchat.route';

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoute);
app.use('/api/webchat', webchatRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const org = new mongoose.Types.ObjectId();
const admin = new mongoose.Types.ObjectId();
const rep = new mongoose.Types.ObjectId();
const slug = `color-${org}`;
const tokens: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

async function publicColor() {
  const res = await request(app).get('/api/webchat/public/config').query({ orgKey: slug }).expect(200);
  return res.body.data.color;
}

describe('Real-DB proof: website chat color (local MongoDB only)', () => {
  beforeAll(async () => {
    await Organization.collection.insertOne({ _id: org, name: 'Color Motors', slug, status: 'active', metadata: {} } as any);
    const crm = (_id: mongoose.Types.ObjectId, role: string) => ({ _id, organizationId: org, fullName: role, username: `u-${_id}`, email: `${role}-${_id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([crm(admin, 'admin'), crm(rep, 'employee')] as any[]);
    tokens.admin = generateCrmToken(String(admin));
    tokens.rep = generateCrmToken(String(rep));
  });

  it('starts with no color, which means the normal Suprah green', async () => {
    expect((await request(app).get('/api/crm/org-settings').set(as('admin')).expect(200)).body.data.webchatColor).toBe('');
    expect(await publicColor()).toBe('');
  });

  it('saves a color for the chat and shows it to website visitors', async () => {
    await request(app).patch('/api/crm/org-settings').set(as('admin')).send({ webchatColor: '#1E6FD9' }).expect(200);
    expect((await request(app).get('/api/crm/org-settings').set(as('admin')).expect(200)).body.data.webchatColor).toBe('#1e6fd9');
    expect(await publicColor()).toBe('#1e6fd9');
  });

  it('refuses a color that is not a hex color and keeps the saved one', async () => {
    for (const bad of ['blue', '#12345', '#1234567', 'url(x)']) {
      await request(app).patch('/api/crm/org-settings').set(as('admin')).send({ webchatColor: bad }).expect(400);
    }
    expect(await publicColor()).toBe('#1e6fd9');
  });

  it('only admins can change it, and other settings saves leave it alone', async () => {
    await request(app).patch('/api/crm/org-settings').set(as('rep')).send({ webchatColor: '#000000' }).expect(403);
    await request(app).patch('/api/crm/org-settings').set(as('admin')).send({ webchatGreeting: 'Hi there' }).expect(200);
    expect(await publicColor()).toBe('#1e6fd9');
  });

  it('goes back to Suprah green when cleared', async () => {
    await request(app).patch('/api/crm/org-settings').set(as('admin')).send({ webchatColor: '' }).expect(200);
    expect(await publicColor()).toBe('');
    const stored: any = await Organization.collection.findOne({ _id: org });
    expect(stored.metadata.webchatColor).toBeUndefined();
  });
});
