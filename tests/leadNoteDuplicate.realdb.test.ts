jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn().mockResolvedValue(undefined) },
}));

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import { addLeadNote } from '../src/controllers/lead.controller';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const mary = { _id: new mongoose.Types.ObjectId(), fullName: 'Mary Pinero' };
const beth = { _id: new mongoose.Types.ObjectId(), fullName: 'Beth Reyes' };
let leadId = '';

async function save(user: { _id: mongoose.Types.ObjectId; fullName: string }, note: string) {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  await addLeadNote({ params: { id: leadId }, body: { note }, orgId: ORG, crmUser: user } as any, res);
  return res;
}

async function notesWith(text: string) {
  const lead: any = await Lead.findById(leadId).lean();
  return (lead.notes || []).filter((note: any) => note.text === text);
}

describe('Real-DB: the same note is not saved twice (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await Lead.collection.deleteMany({ organizationId: orgId });
    const created = await Lead.collection.insertOne({ organizationId: orgId, createdBy: mary._id, firstName: 'Note', lastName: 'Tester', phone: '+18015557702', status: 'New', source: 'Manual Entry', channel: 'sms', notes: [], createdAt: new Date(), updatedAt: new Date() } as any);
    leadId = String(created.insertedId);
  });

  afterAll(async () => {
    await Lead.collection.deleteMany({ organizationId: orgId });
  });

  it('saves the first note and hands back the saved note', async () => {
    const res = await save(mary, 'Called, left a voicemail.');
    expect(res.statusCode).toBe(201);
    expect(res.body.data.note).toMatchObject({ text: 'Called, left a voicemail.', authorName: 'Mary Pinero' });
    expect(res.body.data.note._id).toBeTruthy();
  });

  it('returns the earlier note instead of saving the same text again from the same person', async () => {
    const first = (await notesWith('Called, left a voicemail.'))[0];
    const again = await save(mary, 'Called, left a voicemail.');
    expect(again.statusCode).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(String(again.body.data.note._id)).toBe(String(first._id));
    const padded = await save(mary, '  Called, left a voicemail.  ');
    expect(padded.body.data.duplicate).toBe(true);
    expect(await notesWith('Called, left a voicemail.')).toHaveLength(1);
  });

  it('still saves the same text from a different person, or different text from the same person', async () => {
    expect((await save(beth, 'Called, left a voicemail.')).statusCode).toBe(201);
    expect((await save(mary, 'Customer will come in Saturday.')).statusCode).toBe(201);
    expect(await notesWith('Called, left a voicemail.')).toHaveLength(2);
  });

  it('saves the same text again once 5 minutes have passed', async () => {
    await Lead.updateOne(
      { _id: leadId },
      { $set: { 'notes.$[note].createdAt': new Date(Date.now() - 6 * 60 * 1000) } },
      { arrayFilters: [{ 'note.createdBy': mary._id, 'note.text': 'Called, left a voicemail.' }] },
    );
    const later = await save(mary, 'Called, left a voicemail.');
    expect(later.statusCode).toBe(201);
    expect(await notesWith('Called, left a voicemail.')).toHaveLength(3);
  });
});
