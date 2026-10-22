import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLocation from '../src/models/CrmLocation.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../src/models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../src/models/AiTrainingAuditLog.model';
import AiTrainingImportBatch from '../src/models/AiTrainingImportBatch.model';
import AiTrainingImportItem from '../src/models/AiTrainingImportItem.model';
import AiTrainingImportContent from '../src/models/AiTrainingImportContent.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import AiKnowledgeEntry from '../src/models/AiKnowledgeEntry.model';
import AiKnowledgeEntryVersion from '../src/models/AiKnowledgeEntryVersion.model';
import AiKnowledgeAuditLog from '../src/models/AiKnowledgeAuditLog.model';
import AiKnowledgeKeyLock from '../src/models/AiKnowledgeKeyLock.model';
import AiKnowledgeVerifiedDetail, { AiKnowledgeVerifiedDetailRevision } from '../src/models/AiKnowledgeVerifiedDetail.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { resetTrainingTransactionProbe } from '../src/services/aiTraining.service';
import { IMPORT_COLUMNS } from '../src/services/aiTrainingImportParser';
import aiTrainingRoute from '../src/routes/aiTraining.routes';
import aiKnowledgeBaseRoute from '../src/routes/aiKnowledgeBase.routes';

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use('/api/crm/ai-training', aiTrainingRoute);
app.use('/api/crm/knowledge-base', aiKnowledgeBaseRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const A = String(orgA);
const B = String(orgB);
const users: Record<string, mongoose.Types.ObjectId> = {
  rep: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  manager2: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const loc: Record<string, mongoose.Types.ObjectId> = {
  orem: new mongoose.Types.ObjectId(),
  lehi: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const call = (method: 'get' | 'post' | 'put', path: string, who: string, body?: any) => {
  const req = method === 'get' ? request(app).get(path) : method === 'post' ? request(app).post(path) : request(app).put(path);
  req.set(auth(who));
  return body === undefined ? req : req.send(body);
};
const IMP = '/api/crm/ai-training/imports';
const KB = '/api/crm/knowledge-base';

type Row = Record<string, string>;
const escapeCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const toCsv = (rows: Row[]) => [IMPORT_COLUMNS.map((c) => c.column).join(','), ...rows.map((row) => IMPORT_COLUMNS.map((c) => escapeCell(row[c.column] || '')).join(','))].join('\r\n');
const ALL_SCOPE = { sourceLabel: '', locationId: null };
const body = (rows: Row[], options: Record<string, unknown> = {}) => ({ source: { format: 'csv', fileName: 'podium.csv', content: toCsv(rows) }, options: { locationMappings: [ALL_SCOPE], ...options } });

let counter = 0;
const tag = () => `${Date.now().toString(36)}${++counter}`;

async function preview(who: string, payload: any) {
  const res = await call('post', `${IMP}/preview`, who, payload);
  if (res.status !== 200) throw new Error(`preview ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
}
async function commit(who: string, payload: any) {
  const shown = await preview(who, payload);
  return call('post', IMP, who, { ...payload, previewHash: shown.previewHash, attestation: true });
}
const rowOf = (shown: any, title: string) => shown.rows.find((row: any) => row.title === title);
const entryFor = (itemId: string) => AiKnowledgeEntry.collection.findOne({ organizationId: A, 'source.importItemId': new mongoose.Types.ObjectId(itemId) }) as Promise<any>;
const itemsOf = (batchId: string) => AiTrainingImportItem.collection.find({ organizationId: A, batchId: new mongoose.Types.ObjectId(batchId) }).sort({ rowNumber: 1 }).toArray() as Promise<any[]>;
const entryDoc = (id: any) => AiKnowledgeEntry.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) }) as Promise<any>;
const kbAct = async (who: string, id: any, action: string, extra: Record<string, unknown> = {}) =>
  call('post', `${KB}/entries/${id}/${action}`, who, { expectedVersion: (await entryDoc(id)).currentVersion, ...extra });

const faq = (title: string, question: string, answer: string, extra: Row = {}): Row => ({ type: 'faq', title, trigger_or_question: question, answer_or_instruction: answer, topic: 'hours', ...extra });

describe('Real-DB proof: P2c Podium import into the Knowledge Base (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent, CrmLocation,
      AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiKnowledgeVerifiedDetail, AiKnowledgeVerifiedDetailRevision] as any[]) await model.init();
    await Organization.collection.insertMany([
      { _id: orgA, name: 'KB Import Org', slug: `kbi-a-${orgA}`, status: 'active', metadata: { aiTrainingEnabled: true, aiKnowledgeBaseEnabled: true } },
      { _id: orgB, name: 'KB Import Other', slug: `kbi-b-${orgB}`, status: 'active', metadata: { aiTrainingEnabled: true, aiKnowledgeBaseEnabled: true } },
    ] as any[]);
    const crm = (id: any, org: any, role: string, name: string) => ({ _id: id, organizationId: org, fullName: name, username: `kbi-${id}`, email: `kbi-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.rep, orgA, 'employee', 'Rep One'),
      crm(users.manager, orgA, 'manager', 'Manager One'),
      crm(users.manager2, orgA, 'manager', 'Manager Two'),
      crm(users.admin, orgA, 'admin', 'Admin One'),
      crm(users.otherAdmin, orgB, 'admin', 'Other Admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    const actor = { userId: String(users.admin), name: 'Admin One', role: 'admin' };
    const location = (id: any, code: string, name: string, aliasKeys: string[]) => ({
      _id: id, organizationId: A, code, name, aliases: [], aliasKeys, status: 'active', revision: 1, createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    });
    await CrmLocation.collection.insertMany([location(loc.orem, 'orem', 'Orem', ['orem']), location(loc.lehi, 'lehi', 'Lehi', ['lehi'])] as any[]);
  });

  afterAll(async () => {
    const both = [orgA, orgB, A, B];
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent, CrmLocation, CrmUser, AiAgentCoachingRule,
      AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiKnowledgeVerifiedDetail, AiKnowledgeVerifiedDetailRevision] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: both } });
    }
    await mongoose.connection.db!.collection('crmlocationaudits').deleteMany({ organizationId: { $in: both } });
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
    process.env = env;
  });

  beforeEach(async () => {
    process.env.AI_TRAINING_ENABLED = 'true';
    process.env.AI_TRAINING_IMPORT_ENABLED = 'true';
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    resetTrainingTransactionProbe();
    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiKnowledgeBaseEnabled': true } });
  });

  it('saves FAQ and business information as drafts created by the importer, keeps Podium Off, and needs another reviewer', async () => {
    const t = tag();
    const onRow = faq(`Saturday hours ${t}`, `Are you open on Saturday ${t}?`, 'Yes. Sales is open Saturday from nine to six.', { location: 'Orem', source_status: 'on', source_ref: `FAQ ${t}` });
    const offRow = faq(`Sunday hours ${t}`, `Are you open on Sunday ${t}?`, 'Sales is closed on Sunday.', { source_status: 'off' });
    const bizRow: Row = { type: 'business_info', title: `Lehi showroom ${t}`, answer_or_instruction: 'The Lehi showroom is next to the freeway exit.', topic: 'address_directions', location: 'Lehi' };
    const payload = body([onRow, offRow, bizRow]);
    const shown = await preview('manager', payload);
    expect(shown.knowledgeBase).toEqual({ enabled: true });
    expect([onRow, offRow, bizRow].map((row) => rowOf(shown, row.title).status)).toEqual(['parked_knowledge', 'parked_knowledge', 'parked_knowledge']);
    const proposalsBefore = await AiTrainingPolicy.countDocuments({ organizationId: A });

    const res = await commit('manager', payload);
    expect(res.status).toBe(201);
    expect(res.body.data.knowledgeSave).toMatchObject({ enabled: true, created: 3, updated: 0 });
    expect(await AiTrainingPolicy.countDocuments({ organizationId: A })).toBe(proposalsBefore);
    const batchId = res.body.data.batch.id;
    expect(res.body.data.knowledge.counts).toEqual({ saved: 3 });
    const items = await itemsOf(batchId);
    const [onEntry, offEntry, bizEntry] = await Promise.all(items.map((item) => entryFor(String(item._id))));
    for (const [entry, item] of [[onEntry, items[0]], [offEntry, items[1]], [bizEntry, items[2]]]) {
      expect(entry).toMatchObject({ status: 'draft', lifecycle: 'active', currentVersion: 1, createdBy: { userId: String(users.manager) } });
      expect(entry.approvedVersion).toBeUndefined();
      expect(entry.source).toMatchObject({ system: 'podium_import', importBatchNumber: res.body.data.batch.batchNumber, sourceKey: item.sourceKey, keyRevision: 1 });
      expect(String(entry.source.importBatchId)).toBe(batchId);
      expect(await AiTrainingImportContent.countDocuments({ organizationId: A, itemId: item._id })).toBe(1);
    }
    expect(onEntry.source.sourceStatus).toBe('on');
    expect(offEntry.source.sourceStatus).toBe('off');
    expect(onEntry.source.sourceRef).toBe(`FAQ ${t}`);
    expect(onEntry.locationScope.scope).toBe('locations');
    expect(onEntry.locationScope.locationIds.map(String)).toEqual([String(loc.orem)]);
    expect(offEntry.locationScope).toMatchObject({ scope: 'all' });
    expect(bizEntry.locationScope.locationIds.map(String)).toEqual([String(loc.lehi)]);
    const version: any = await AiKnowledgeEntryVersion.collection.findOne({ entryId: onEntry._id, version: 1 });
    expect(version.content).toMatchObject({ question: onRow.trigger_or_question, answer: onRow.answer_or_instruction, title: onRow.title });
    expect(version.changeNote).toBe(`Imported from Podium, import #${res.body.data.batch.batchNumber}`);
    expect(await AiKnowledgeAuditLog.countDocuments({ entryId: onEntry._id, action: 'entry_created' })).toBe(1);

    const apiView = (await call('get', `${KB}/entries/${offEntry._id}`, 'manager2').expect(200)).body.data.entry;
    expect(apiView.source).toMatchObject({ system: 'podium_import', sourceStatus: 'off', importBatchNumber: res.body.data.batch.batchNumber });

    expect((await kbAct('manager', onEntry._id, 'submit')).status).toBe(200);
    expect((await kbAct('manager', onEntry._id, 'approve')).status).toBe(403);
    expect((await kbAct('manager2', onEntry._id, 'approve')).status).toBe(200);
    expect((await entryDoc(offEntry._id)).status).toBe('draft');
  });

  it('requires an explicit choice for unmapped Podium locations and never falls back to All Locations', async () => {
    const t = tag();
    const unmapped = faq(`Springville hours ${t}`, `Is the Springville store open late ${t}?`, 'The Springville store is open until eight.', { location: 'Springville' });
    const blank = faq(`Holiday hours ${t}`, `Are you open on holidays ${t}?`, 'Holiday hours are posted on the door.');
    const noMapping = { source: { format: 'csv', content: toCsv([unmapped, blank]) }, options: {} };
    const shown = await preview('manager', noMapping);
    expect(rowOf(shown, unmapped.title).status).toBe('needs_location');
    expect(rowOf(shown, blank.title).status).toBe('needs_location');
    expect(shown.canCommit).toBe(false);
    expect((await call('post', IMP, 'manager', { ...noMapping, previewHash: shown.previewHash, attestation: true })).status).toBe(409);
    expect(await AiKnowledgeEntry.countDocuments({ organizationId: A, title: { $in: [unmapped.title, blank.title] } })).toBe(0);

    const mapped = body([unmapped], { locationMappings: [{ sourceLabel: 'Springville', locationId: String(loc.lehi) }] });
    const res = await commit('manager', mapped);
    expect(res.status).toBe(201);
    const entry: any = await AiKnowledgeEntry.collection.findOne({ organizationId: A, title: unmapped.title });
    expect(entry.locationScope.scope).toBe('locations');
    expect(entry.locationScope.locationIds.map(String)).toEqual([String(loc.lehi)]);
    expect(entry.source.sourceLocationLabel).toBe('Springville');
  });

  it('keeps items with unverified contacts, explains what to do, and saves them once the contact is verified', async () => {
    const t = tag();
    const phone = `385-867-${String(5000 + counter)}`;
    const row = faq(`Call sales ${t}`, `What number do I call for sales ${t}?`, `Call our sales team at ${phone} during business hours.`, { topic: 'contact' });
    const stranger = faq(`Stranger ${t}`, `Who do I call after hours ${t}?`, 'Call 385-867-9911 after hours.', { topic: 'contact' });
    const payload = body([row, stranger], { businessContacts: [{ kind: 'phone', value: phone }] });
    const shown = await preview('manager', payload);
    expect(rowOf(shown, row.title).status).toBe('parked_knowledge');
    expect(rowOf(shown, row.title).issues.map((issue: any) => issue.code)).toContain('knowledge_contact_unverified');
    expect(shown.rows.find((r: any) => r.snippet.includes('after hours') || r.status === 'blocked_privacy').status).toBe('blocked_privacy');
    const beforeMapping = await preview('manager', { source: payload.source, options: { businessContacts: [{ kind: 'phone', value: phone }] } });
    expect(rowOf(beforeMapping, row.title).status).toBe('needs_location');
    expect(rowOf(beforeMapping, row.title).issues.map((issue: any) => issue.code)).toContain('knowledge_contact_unverified');

    const res = await commit('manager', payload);
    expect(res.status).toBe(201);
    expect(res.body.data.knowledgeSave).toMatchObject({ created: 0, counts: { needs_contact_verification: 1 } });
    const batchId = res.body.data.batch.id;
    const [item] = (await itemsOf(batchId)).filter((candidate) => candidate.status === 'parked_knowledge');
    expect(await entryFor(String(item._id))).toBeNull();
    expect(await AiTrainingImportContent.countDocuments({ organizationId: A, itemId: item._id })).toBe(1);
    const shownItem = res.body.data.items.find((candidate: any) => candidate.id === String(item._id));
    expect(shownItem.knowledge.state).toBe('needs_contact_verification');
    expect(shownItem.knowledge.message).toMatch(/Verified contacts & programs/);
    expect(JSON.stringify(res.body.data)).not.toContain('385-867-9911');

    const proposed = await call('post', `${KB}/verified-details`, 'manager2', { kind: 'phone', value: phone, label: 'Sales', locations: { scope: 'all' } });
    expect(proposed.status).toBe(201);
    const whilePending = await call('post', `${IMP}/${batchId}/knowledge`, 'manager', {});
    expect(whilePending.status).toBe(200);
    expect(whilePending.body.data).toMatchObject({ created: 0, counts: { needs_contact_verification: 1 } });
    expect(whilePending.body.data.results[0].message).toMatch(/waiting for approval in Verified contacts/);
    expect(await entryFor(String(item._id))).toBeNull();
    const pendingDetail = (await call('get', `${IMP}/${batchId}?page=1&limit=100`, 'manager')).body.data.items.find((candidate: any) => candidate.id === String(item._id));
    expect(pendingDetail.knowledge).toMatchObject({ state: 'needs_contact_verification', message: expect.stringMatching(/waiting for approval/) });

    const again = faq(`Call sales again ${t}`, `Is ${phone} the sales line ${t}?`, `Yes, ${phone} reaches the sales team.`, { topic: 'contact' });
    const recognized = await preview('manager', body([again]));
    expect(rowOf(recognized, again.title).status).toBe('parked_knowledge');
    expect(rowOf(recognized, again.title).issues.find((issue: any) => issue.code === 'knowledge_contact_unverified').message).toMatch(/waiting for approval/);

    expect((await call('post', `${KB}/verified-details/${proposed.body.data.id}/approve`, 'manager2', { expectedRevision: 1 })).status).toBe(403);
    expect((await call('post', `${KB}/verified-details/${proposed.body.data.id}/approve`, 'admin', { expectedRevision: 1 })).status).toBe(200);
    const saved = await call('post', `${IMP}/${batchId}/knowledge`, 'manager', {});
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ created: 1, counts: { saved: 1 } });
    const entry = await entryFor(String(item._id));
    const version: any = await AiKnowledgeEntryVersion.collection.findOne({ entryId: entry._id, version: 1 });
    expect(version.content.answer).toContain(phone);

    const second = await preview('manager', body([again]));
    expect(rowOf(second, again.title).status).toBe('parked_knowledge');
    expect(rowOf(second, again.title).issues.map((issue: any) => issue.code)).not.toContain('knowledge_contact_unverified');
  });

  it('flags similar manual entries for review without merging or changing them', async () => {
    const t = tag();
    const question = `Do you take walk ins for test drives ${t}?`;
    const manual = await call('post', `${KB}/entries`, 'rep', { kind: 'faq', topic: 'test_drives', question, answer: 'Yes, walk-ins are welcome any time we are open.', channels: ['sms'], locations: { scope: 'all' } });
    expect(manual.status).toBe(201);
    const manualId = manual.body.data.entry.id;
    const before = JSON.stringify(await entryDoc(manualId));
    const row = faq(`Walk ins ${t}`, question, 'Walk-ins are welcome, but appointments are faster.', { topic: 'test_drives' });
    const shown = await preview('manager', body([row]));
    const issue = rowOf(shown, row.title).issues.find((candidate: any) => candidate.code === 'knowledge_similar_entry');
    expect(issue.message).toMatch(/Both are kept/);
    const res = await commit('manager', body([row]));
    expect(res.body.data.knowledgeSave.created).toBe(1);
    const imported: any = await AiKnowledgeEntry.collection.findOne({ organizationId: A, title: row.title });
    expect(String(imported._id)).not.toBe(manualId);
    expect(JSON.stringify(await entryDoc(manualId))).toBe(before);
    const detail = (await call('get', `${KB}/entries/${imported._id}`, 'manager2').expect(200)).body.data;
    expect(detail.duplicates.map((dup: any) => dup.id)).toContain(manualId);
  });

  it('ignores unchanged re-imports and turns changed ones into a draft revision that keeps the approved version', async () => {
    const t = tag();
    const row = faq(`Service hours ${t}`, `When is service open ${t}?`, 'Service is open weekdays from seven to six.', { topic: 'service' });
    const first = await commit('manager', body([row]));
    const firstItem = (await itemsOf(first.body.data.batch.id))[0];
    const entry = await entryFor(String(firstItem._id));
    await kbAct('manager', entry._id, 'submit');
    expect((await kbAct('manager2', entry._id, 'approve')).status).toBe(200);

    const same = await preview('manager', body([row]));
    expect(rowOf(same, row.title).status).toBe('unchanged');
    const sameRes = await commit('manager', body([row]));
    expect(sameRes.body.data.knowledgeSave).toMatchObject({ created: 0, updated: 0 });
    expect((await entryDoc(entry._id)).currentVersion).toBe(1);

    const changed = { ...row, answer_or_instruction: 'Service is open weekdays from seven to six and Saturday mornings.' };
    const shown = await preview('manager', body([changed]));
    expect(rowOf(shown, row.title).status).toBe('parked_knowledge');
    expect(rowOf(shown, row.title).issues.map((issue: any) => issue.code)).toContain('knowledge_revision');
    const res = await commit('manager', body([changed]));
    expect(res.body.data.knowledgeSave).toMatchObject({ created: 0, updated: 1 });
    const updated = await entryDoc(entry._id);
    expect(updated).toMatchObject({ status: 'draft', currentVersion: 2, approvedVersion: 1 });
    expect(updated.source.keyRevision).toBe(2);
    const newItem = (await itemsOf(res.body.data.batch.id))[0];
    expect(String(updated.source.importItemId)).toBe(String(newItem._id));
    expect(await AiKnowledgeEntryVersion.countDocuments({ entryId: entry._id })).toBe(2);
    const approvedVersion: any = await AiKnowledgeEntryVersion.collection.findOne({ entryId: entry._id, version: 1 });
    expect(approvedVersion.content.answer).toBe(row.answer_or_instruction);
    expect(await AiKnowledgeAuditLog.countDocuments({ entryId: entry._id, action: 'version_saved' })).toBe(1);
    expect(await AiKnowledgeEntry.countDocuments({ organizationId: A, 'source.sourceKey': firstItem.sourceKey })).toBe(1);

    const oldAgain = await call('post', `${IMP}/${first.body.data.batch.id}/knowledge`, 'manager', {});
    expect(oldAgain.body.data).toMatchObject({ created: 0, updated: 0 });
    expect(oldAgain.body.data.results[0].state).toBe('newer_saved');
    await kbAct('manager', entry._id, 'submit');
    expect((await kbAct('manager', entry._id, 'approve')).status).toBe(403);
    expect((await kbAct('manager2', entry._id, 'approve')).status).toBe(200);
  });

  it('does not update an archived entry and says how to fix it', async () => {
    const t = tag();
    const row = faq(`Parts hours ${t}`, `When is the parts counter open ${t}?`, 'Parts is open weekdays.', { topic: 'service' });
    const first = await commit('manager', body([row]));
    const entry = await entryFor(String((await itemsOf(first.body.data.batch.id))[0]._id));
    expect((await kbAct('manager2', entry._id, 'archive')).status).toBe(200);
    const changed = { ...row, answer_or_instruction: 'Parts is open weekdays and Saturday.' };
    const shown = await preview('manager', body([changed]));
    expect(rowOf(shown, row.title).issues.map((issue: any) => issue.code)).toContain('knowledge_entry_inactive');
    const res = await commit('manager', body([changed]));
    expect(res.body.data.knowledgeSave.counts).toEqual(expect.objectContaining({ needs_attention: 1 }));
    expect(res.body.data.knowledgeSave.results[0].message).toMatch(/restore it/);
    expect((await entryDoc(entry._id)).currentVersion).toBe(1);
  });

  it('keeps items as candidates while the Knowledge Base is off and saves them after it is turned on', async () => {
    const t = tag();
    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiKnowledgeBaseEnabled': false } });
    const row = faq(`Detail hours ${t}`, `When can I get my car detailed ${t}?`, 'Detailing is by appointment.', { topic: 'appointments' });
    const shown = await preview('manager', body([row]));
    expect(shown.knowledgeBase).toEqual({ enabled: false });
    expect(rowOf(shown, row.title).status).toBe('parked_knowledge');
    const res = await commit('manager', body([row]));
    expect(res.status).toBe(201);
    expect(res.body.data.knowledgeSave).toMatchObject({ enabled: false });
    expect(res.body.data.knowledgeSave.message).toMatch(/admin can turn it on/);
    const batchId = res.body.data.batch.id;
    const item = (await itemsOf(batchId))[0];
    expect(await entryFor(String(item._id))).toBeNull();
    expect(res.body.data.items[0].knowledge.state).toBe('knowledge_base_off');
    expect((await call('post', `${IMP}/${batchId}/knowledge`, 'manager', {})).status).toBe(409);

    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiKnowledgeBaseEnabled': true } });
    const saved = await call('post', `${IMP}/${batchId}/knowledge`, 'manager', {});
    expect(saved.body.data.created).toBe(1);

    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'false';
    const serverOff = await preview('manager', body([faq(`Wash ${t}`, `Do you wash cars ${t}?`, 'Every service includes a wash.', { topic: 'service' })]));
    expect(serverOff.knowledgeBase).toEqual({ enabled: false });
  });

  it('enforces roles and org isolation, and never creates duplicates when saved twice or at the same time', async () => {
    const t = tag();
    const row = faq(`Loaner cars ${t}`, `Do you have loaner cars ${t}?`, 'Ask the service team about loaner availability.', { topic: 'service' });
    expect((await call('post', `${IMP}/preview`, 'rep', body([row]))).status).toBe(403);
    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiKnowledgeBaseEnabled': false } });
    const res = await commit('admin', body([row]));
    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiKnowledgeBaseEnabled': true } });
    const batchId = res.body.data.batch.id;
    expect((await call('post', `${IMP}/${batchId}/knowledge`, 'rep', {})).status).toBe(403);
    expect((await call('post', `${IMP}/${batchId}/knowledge`, 'otherAdmin', {})).status).toBe(404);
    const [one, two] = await Promise.all([
      call('post', `${IMP}/${batchId}/knowledge`, 'admin', {}),
      call('post', `${IMP}/${batchId}/knowledge`, 'manager', {}),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const item = (await itemsOf(batchId))[0];
    expect(await AiKnowledgeEntry.countDocuments({ organizationId: A, 'source.importItemId': item._id })).toBe(1);
    expect((one.body.data.created || 0) + (two.body.data.created || 0)).toBe(1);
    const third = await call('post', `${IMP}/${batchId}/knowledge`, 'admin', {});
    expect(third.body.data).toMatchObject({ created: 0, counts: { saved: 1 } });
    expect(await AiKnowledgeEntry.countDocuments({ organizationId: B })).toBe(0);
    expect(await AiAgentCoachingRule.countDocuments({ organizationId: A })).toBe(0);
  });
});
