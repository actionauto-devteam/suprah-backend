import { execFileSync } from 'child_process';
import path from 'path';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import Lead from '../src/models/lead.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE_PHONE = '+18015550142';
const TEST_MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';

function runScript(scriptPath: string): string {
  return execFileSync(
    'npx',
    ['ts-node', '--transpile-only', '-r', 'tsconfig-paths/register', scriptPath],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MONGODB_URI: TEST_MONGODB_URI },
      encoding: 'utf8',
      shell: true,
    },
  );
}

async function fixtureCounts() {
  const lead = await Lead.findOne({ phone: FIXTURE_PHONE });
  if (!lead) return null;
  const notes = (lead.notes || []) as any[];
  const noteTexts = notes.map((n) => n.text);
  return {
    leadId: String(lead._id),
    notes: notes.length,
    duplicateNoteTexts: noteTexts.filter((t, i) => noteTexts.indexOf(t) !== i),
    tasks: await AiAgentTask.countDocuments({ leadId: lead._id }),
    messages: await CommunicationMessage.countDocuments({ leadId: lead._id }),
    leadCount: await Lead.countDocuments({ phone: FIXTURE_PHONE }),
  };
}

describe('Real-DB proof: seed-local-alex-fixtures.ts is idempotent and self-healing', () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_MONGODB_URI);
    }
    const org = await Organization.findOne({ slug: 'suprah-local-dev' });
    if (!org) {
      runScript(path.join(REPO_ROOT, 'src/scripts/seed-local-dev.ts'));
    }

    const leftover = await Lead.findOne({ phone: FIXTURE_PHONE });
    if (leftover) {
      await AiAgentTask.deleteMany({ leadId: leftover._id });
      await CommunicationMessage.deleteMany({ leadId: leftover._id });
      await Conversation.deleteMany({ customerPhone: FIXTURE_PHONE });
      await Lead.deleteOne({ _id: leftover._id });
    }
    await CrmLeadGroup.deleteMany({ name: 'Fixture Online Team' });
  });

  afterAll(async () => {
    const lead = await Lead.findOne({ phone: FIXTURE_PHONE });
    if (lead) {
      await AiAgentTask.deleteMany({ leadId: lead._id });
      await CommunicationMessage.deleteMany({ leadId: lead._id });
      await Conversation.deleteMany({ customerPhone: FIXTURE_PHONE });
      await Lead.deleteOne({ _id: lead._id });
    }
    await CrmLeadGroup.deleteMany({ name: 'Fixture Online Team' });
  });

  it('creates the full fixture set on a fresh run', async () => {
    const out = runScript(path.join(REPO_ROOT, 'src/scripts/seed-local-alex-fixtures.ts'));
    expect(out).toMatch(/Created fixture Lead/);
    expect(out).toMatch(/Created fixture AiAgentTask/);
    expect(out).toMatch(/Added 6 fixture note\(s\)/);

    const counts = await fixtureCounts();
    expect(counts).toMatchObject({ notes: 6, tasks: 1, messages: 2, leadCount: 1, duplicateNoteTexts: [] });
  });

  it('is fully idempotent: rerunning immediately creates nothing new', async () => {
    const out = runScript(path.join(REPO_ROOT, 'src/scripts/seed-local-alex-fixtures.ts'));
    expect(out).toMatch(/Reusing existing fixture Lead/);
    expect(out).toMatch(/Reusing existing fixture AiAgentTask/);
    expect(out).toMatch(/Fixture notes already present/);
    expect(out).toMatch(/Fixture messages already present/);

    const counts = await fixtureCounts();
    expect(counts).toMatchObject({ notes: 6, tasks: 1, messages: 2, leadCount: 1, duplicateNoteTexts: [] });
  });

  it('heals a partially-interrupted seed without duplicating what survived', async () => {
    const lead = await Lead.findOne({ phone: FIXTURE_PHONE });
    expect(lead).toBeTruthy();

    (lead!.notes as any) = (lead!.notes as any).slice(0, 3);
    await lead!.save();
    await AiAgentTask.deleteMany({ leadId: lead!._id });
    const outboundMessage = await CommunicationMessage.findOne({ leadId: lead!._id, direction: 'outbound' });
    if (outboundMessage) await CommunicationMessage.deleteOne({ _id: outboundMessage._id });

    const partialCounts = await fixtureCounts();
    expect(partialCounts).toMatchObject({ notes: 3, tasks: 0, messages: 1 });

    const out = runScript(path.join(REPO_ROOT, 'src/scripts/seed-local-alex-fixtures.ts'));
    expect(out).toMatch(/Reusing existing fixture Lead/);
    expect(out).toMatch(/Created 1 fixture message\(s\)/);
    expect(out).toMatch(/Created fixture AiAgentTask/);
    expect(out).toMatch(/Added 3 fixture note\(s\)/);

    const healedCounts = await fixtureCounts();
    expect(healedCounts).toMatchObject({ notes: 6, tasks: 1, messages: 2, leadCount: 1, duplicateNoteTexts: [] });
  });

  it('refuses to run against a non-local MongoDB URI', () => {
    expect(() =>
      execFileSync(
        'npx',
        ['ts-node', '--transpile-only', '-r', 'tsconfig-paths/register', 'src/scripts/seed-local-alex-fixtures.ts'],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, MONGODB_URI: 'mongodb+srv://prod-cluster.mongodb.net/supra-ai-prod' },
          encoding: 'utf8',
          shell: true,
        },
      ),
    ).toThrow();
  });
});
