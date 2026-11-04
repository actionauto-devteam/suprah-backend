import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLocation from '../src/models/CrmLocation.model';
import AiKnowledgeAuditLog from '../src/models/AiKnowledgeAuditLog.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { loadReplyKnowledge } from '../src/services/aiKnowledgeRuntime.service';
import aiKnowledgeBaseRoute from '../src/routes/aiKnowledgeBase.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/knowledge-base', aiKnowledgeBaseRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const loc = { orem: new mongoose.Types.ObjectId(), lehi: new mongoose.Types.ObjectId() };
const users = { admin: new mongoose.Types.ObjectId(), manager: new mongoose.Types.ObjectId() };
const tokens: Record<string, string> = {};
const author = { userId: 'author', name: 'Fictional author', role: 'employee' };
const db = () => mongoose.connection.db!;
const ask = (body: string) => [{ from: 'customer', body }];
const titles = (rows: Array<{ title: string }>) => rows.map((row) => row.title).sort();
let created: mongoose.Types.ObjectId[] = [];

async function entry(title: string, options: {
  answer?: string;
  approved?: boolean;
  scope?: { scope: 'all' | 'locations'; locationIds: mongoose.Types.ObjectId[] };
  suspended?: mongoose.Types.ObjectId[];
  lifecycle?: string;
  invalidated?: boolean;
  channels?: string[];
  amounts?: string[];
  draftAnswer?: string;
  topic?: string;
  updatedAt?: Date;
} = {}) {
  const id = new mongoose.Types.ObjectId();
  created.push(id);
  const scope = options.scope || { scope: 'all', locationIds: [] };
  const content = (answer: string) => ({ kind: 'faq', topic: options.topic || 'general', title, question: title, answer, channels: options.channels || ['sms', 'webchat'], locationScope: scope });
  const approved = options.approved !== false;
  await db().collection('aiknowledgeentries').insertOne({
    _id: id, organizationId: ORG, kind: 'faq', topic: options.topic || 'general', title, question: title, questionKey: title.toLowerCase(),
    channels: options.channels || ['sms', 'webchat'], locationScope: scope, status: approved ? 'approved' : 'draft', lifecycle: options.lifecycle || 'active',
    currentVersion: options.draftAnswer ? 2 : 1,
    ...(approved ? { approvedVersion: 1, approvedLocationScope: scope, approvalSuspendedLocationIds: options.suspended || [] } : {}),
    ...(options.invalidated ? { approvalInvalidation: { reason: 'entry_restored', at: new Date() } } : {}),
    ...(options.amounts ? { amountApproval: { amounts: options.amounts, by: author, at: new Date() } } : {}),
    source: { system: 'manual' }, createdBy: author, createdAt: new Date(), updatedAt: options.updatedAt || new Date(),
  });
  await db().collection('aiknowledgeentryversions').insertOne({ organizationId: ORG, entryId: id, version: 1, content: content(options.answer || `${title} answer.`), createdBy: author, createdAt: new Date() });
  if (options.draftAnswer) {
    await db().collection('aiknowledgeentryversions').insertOne({ organizationId: ORG, entryId: id, version: 2, content: content(options.draftAnswer), createdBy: author, createdAt: new Date() });
  }
  return String(id);
}

const settings = (who: string, body: Record<string, unknown>) =>
  request(app).patch('/api/crm/knowledge-base/settings').set({ Authorization: `Bearer ${tokens[who]}` }).send(body);
const status = async () => (await request(app).get('/api/crm/knowledge-base/status').set({ Authorization: `Bearer ${tokens.admin}` })).body.data;

describe('Real-DB proof: the AI agent reads only approved Knowledge Base answers (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
    await Organization.collection.insertOne({ _id: orgId, name: 'Fictional Runtime Motors', slug: `kbr-${orgId}`, status: 'active', metadata: { aiKnowledgeBaseEnabled: true, aiKnowledgeRepliesEnabled: true } } as any);
    await CrmUser.collection.insertMany([
      { _id: users.admin, organizationId: orgId, fullName: 'Fictional admin', username: `kbr-a-${orgId}`, email: `kbr-a-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: users.manager, organizationId: orgId, fullName: 'Fictional manager', username: `kbr-m-${orgId}`, email: `kbr-m-${orgId}@example.com`, role: 'manager', isActive: true, password: 'x' },
    ] as any[]);
    tokens.admin = generateCrmToken(String(users.admin));
    tokens.manager = generateCrmToken(String(users.manager));
    const actor = { userId: String(users.admin), name: 'Fictional admin', role: 'admin' };
    const location = (id: mongoose.Types.ObjectId, name: string, aliasKeys: string[]) => ({
      _id: id, organizationId: ORG, code: `${name.toLowerCase()}-${orgId}`, name, aliases: [], aliasKeys, status: 'active', revision: 1, createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    });
    await CrmLocation.collection.insertMany([location(loc.orem, 'Orem', ['orem', 'action auto orem']), location(loc.lehi, 'Lehi', ['lehi'])] as any[]);
  });

  afterAll(async () => {
    await db().collection('aiknowledgeentries').deleteMany({ organizationId: ORG });
    await db().collection('aiknowledgeentryversions').deleteMany({ organizationId: ORG });
    await AiKnowledgeAuditLog.collection.deleteMany({ organizationId: ORG });
    await CrmLocation.collection.deleteMany({ organizationId: ORG });
    await CrmUser.collection.deleteMany({ _id: { $in: Object.values(users) } });
    await Organization.collection.deleteMany({ _id: orgId });
    process.env = env;
  });

  beforeEach(async () => {
    await db().collection('aiknowledgeentries').deleteMany({ organizationId: ORG });
    await db().collection('aiknowledgeentryversions').deleteMany({ organizationId: ORG });
    created = [];
  });

  it('uses only the approved version of active, approved answers for the reply channel', async () => {
    await entry('Saturday hours', { answer: 'We are open Saturday 9 to 6.', draftAnswer: 'We are open Saturday 9 to 8.' });
    await entry('Draft question', { approved: false });
    await entry('Disabled question', { lifecycle: 'disabled' });
    await entry('Archived question', { lifecycle: 'archived' });
    await entry('Invalidated question', { invalidated: true });
    await entry('Email only question', { channels: ['email'] });
    const answers = await loadReplyKnowledge({ organizationId: ORG, channel: 'sms', location: 'Orem', transcript: ask('Are you open Saturday?') });
    expect(titles(answers)).toEqual(['Saturday hours']);
    expect(answers[0].answer).toBe('We are open Saturday 9 to 6.');
    expect(await loadReplyKnowledge({ organizationId: ORG, channel: 'webchat', location: null, transcript: ask('hours?') })).toHaveLength(1);
  });

  it('follows the approved locations, including other names for a location and suspended locations', async () => {
    await entry('Orem only', { scope: { scope: 'locations', locationIds: [loc.orem] } });
    await entry('All but suspended Orem', { suspended: [loc.orem] });
    await entry('Everywhere');
    const at = async (location: unknown) => titles(await loadReplyKnowledge({ organizationId: ORG, channel: 'sms', location, transcript: ask('question') }));
    expect(await at('Orem')).toEqual(['Everywhere', 'Orem only']);
    expect(await at('Action Auto - Orem')).toEqual(['Everywhere', 'Orem only']);
    expect(await at('Lehi')).toEqual(['All but suspended Orem', 'Everywhere']);
    expect(await at('')).toEqual(['All but suspended Orem', 'Everywhere']);
    expect(await at('Somewhere else')).toEqual(['All but suspended Orem', 'Everywhere']);
  });

  it('keeps an answer with money amounts only when a manager allowed exactly those amounts', async () => {
    await entry('Deposit', { answer: '$500 which is non-refundable, but goes towards the purchase of the vehicle.', amounts: ['$500'] });
    await entry('Doc fee', { answer: 'Our doc fee is $299.', amounts: ['$199'] });
    await entry('Old fee', { answer: 'The fee is $50.' });
    const answers = await loadReplyKnowledge({ organizationId: ORG, channel: 'sms', location: 'Orem', transcript: ask('deposit?') });
    expect(titles(answers)).toEqual(['Deposit']);
    expect(answers[0].approvedAmounts).toEqual(['$500']);
  });

  it('with many answers, keeps the ones that match what the customer asked', async () => {
    await entry('How much is the deposit?', { topic: 'financing_process', updatedAt: new Date(Date.now() - 86400000) });
    for (let i = 0; i < 45; i += 1) await entry(`Filler question ${i}`);
    const answers = await loadReplyKnowledge({ organizationId: ORG, channel: 'sms', location: 'Orem', transcript: ask('How much is the deposit to hold the truck?') });
    expect(answers).toHaveLength(40);
    expect(answers.map((row) => row.title)).toContain('How much is the deposit?');
  });

  it('reads nothing when the server, the Knowledge Base or AI Agent replies are off', async () => {
    await entry('Everywhere');
    const load = () => loadReplyKnowledge({ organizationId: ORG, channel: 'sms', location: 'Orem', transcript: ask('hi') });
    expect(await load()).toHaveLength(1);
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeRepliesEnabled': false } });
    expect(await load()).toEqual([]);
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeRepliesEnabled': true, 'metadata.aiKnowledgeBaseEnabled': false } });
    expect(await load()).toEqual([]);
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeBaseEnabled': true } });
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'false';
    expect(await load()).toEqual([]);
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
    expect(await loadReplyKnowledge({ organizationId: 'not-an-id', channel: 'sms', transcript: ask('hi') })).toEqual([]);
  });

  it('only an admin turns AI Agent replies on or off, it needs the Knowledge Base on, and every change is recorded', async () => {
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeRepliesEnabled': false } });
    expect(await status()).toMatchObject({ enabled: true, repliesEnabled: false, affectsAlex: false });
    expect((await settings('manager', { setting: 'ai_replies', enabled: true })).status).toBe(403);
    expect((await settings('admin', { setting: 'ai_replies', enabled: 'yes' })).status).toBe(400);
    const on = await settings('admin', { setting: 'ai_replies', enabled: true, reason: 'Testing in Training mode first' });
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({ repliesEnabled: true, affectsAlex: true });
    expect(await AiKnowledgeAuditLog.countDocuments({ organizationId: ORG, action: 'knowledge_replies_enabled', note: 'Testing in Training mode first' })).toBe(1);
    await settings('admin', { setting: 'ai_replies', enabled: true }).expect(200);
    expect(await AiKnowledgeAuditLog.countDocuments({ organizationId: ORG, action: 'knowledge_replies_enabled' })).toBe(1);
    await settings('admin', { enabled: false }).expect(200);
    expect(await status()).toMatchObject({ orgEnabled: false, repliesEnabled: true, affectsAlex: false });
    await settings('admin', { setting: 'ai_replies', enabled: false }).expect(200);
    expect((await settings('admin', { setting: 'ai_replies', enabled: true })).status).toBe(409);
    await settings('admin', { enabled: true }).expect(200);
    await settings('admin', { setting: 'ai_replies', enabled: true }).expect(200);
    expect(await AiKnowledgeAuditLog.countDocuments({ organizationId: ORG, action: { $in: ['knowledge_replies_enabled', 'knowledge_replies_disabled'] } })).toBe(3);
  });
});
