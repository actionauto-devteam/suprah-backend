import mongoose from 'mongoose';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import { AI_AGENT_DRAFT_REPORTING_INDEXES } from '../src/constants/aiAgentDraftIndexes';
import { verifyAiAgentDraftReportingIndexes, createAiAgentDraftReportingIndexes } from '../src/services/aiAgentDraftIndexes.service';

const collection = `aiagentdrafts_index_check_${Date.now()}`;

describe('Real-DB proof: AiAgentDraft reporting indexes are opt-in (local dev MongoDB only)', () => {
  afterAll(async () => {
    await mongoose.connection.db!.collection(collection).drop().catch(() => undefined);
  });

  it('are not declared on the schema, so a normal deploy never builds them', () => {
    const declared = AiAgentDraft.schema.indexes().map(([, options]) => options?.name);
    for (const index of AI_AGENT_DRAFT_REPORTING_INDEXES) expect(declared).not.toContain(index.name);
  });

  it('report missing, build only the two reporting indexes when asked, and are idempotent', async () => {
    await mongoose.connection.db!.collection(collection).insertOne({ organizationId: 'x', status: 'ready', channel: 'sms', createdAt: new Date() });
    const before = await verifyAiAgentDraftReportingIndexes(collection);
    expect(before.ready).toBe(false);
    expect(before.required.map((index) => index.state)).toEqual(['missing', 'missing']);

    const first = await createAiAgentDraftReportingIndexes(collection);
    expect(first.created).toEqual(['ai_draft_org_status_recent', 'ai_draft_org_channel_recent']);
    expect(first.after.ready).toBe(true);

    const second = await createAiAgentDraftReportingIndexes(collection);
    expect(second.created).toEqual([]);
    const names = (await mongoose.connection.db!.collection(collection).indexes()).map((index) => index.name).sort();
    expect(names).toEqual(['_id_', 'ai_draft_org_channel_recent', 'ai_draft_org_status_recent']);
  });

  it('refuses to reuse a name that already has a different definition', async () => {
    const other = `${collection}_conflict`;
    await mongoose.connection.db!.collection(other).createIndex({ organizationId: 1 }, { name: 'ai_draft_org_status_recent' });
    try {
      await expect(createAiAgentDraftReportingIndexes(other)).rejects.toThrow(/different definition/);
    } finally {
      await mongoose.connection.db!.collection(other).drop().catch(() => undefined);
    }
  });
});
