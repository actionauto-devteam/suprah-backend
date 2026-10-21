import fs from 'fs';
import path from 'path';

const mockGenerate = jest.fn();
const mockFind = jest.fn();
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockFind } }));
jest.mock('../../src/models/AiAgentDraft.model', () => ({ __esModule: true, default: { create: mockFind, updateMany: mockFind, findOneAndUpdate: mockFind } }));
jest.mock('../../src/models/AiUsageCounter.model', () => ({ __esModule: true, default: { findOneAndUpdate: mockFind, create: mockFind } }));
const mockWarn = jest.fn();
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: mockWarn, error: jest.fn() } }));

import { queueShadowDraft, queueShadowAttentionSkip } from '../../src/services/aiShadowDraft.service';

const SRC = path.resolve(__dirname, '../../src');
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
const source = { organizationId: 'org-1', channel: 'sms' as const, sourceMessageId: 'm-1', sourceMessageModel: 'CommunicationMessage' as const };

describe('shadow draft queue helpers', () => {
  const env = { ...process.env };
  beforeEach(() => { jest.clearAllMocks(); process.env = { ...env }; });
  afterAll(() => { process.env = env; });

  it('do nothing at all, not even a database read, while the global flag is off', async () => {
    delete process.env.AI_SHADOW_DRAFTS_ENABLED;
    await expect(queueShadowDraft({ ...source, lead: {} })).resolves.toBeUndefined();
    await expect(queueShadowAttentionSkip(source)).resolves.toBeUndefined();
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('never reject into the live caller when the shadow run fails, and log only ids and codes', async () => {
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    process.env.AI_AGENT_ENABLED = 'true';
    mockFind.mockImplementation(() => { throw new Error('database unavailable SECRET-BODY'); });
    await expect(queueShadowDraft({ ...source, lead: {} })).resolves.toBeUndefined();
    await expect(queueShadowAttentionSkip({ ...source, conversationId: '507f1f77bcf86cd799439011' })).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('SECRET-BODY');
  });
});

describe('inbound shadow hooks placement', () => {
  const files = {
    sms: read('services/communication.service.ts'),
    webchat: read('controllers/webchat.controller.ts'),
    email: read('services/aiEmailReply.service.ts'),
  };

  it('are fire-and-forget: the live path never awaits a shadow run', () => {
    for (const text of Object.values(files)) {
      expect(text).not.toMatch(/await\s+queueShadow/);
      expect(text).not.toMatch(/\bgenerateShadowDraft\(|\brecordShadowAttentionSkip\(|\bclaimShadowDraft\(/);
    }
  });

  it('only queue a draft inside the existing not-sending branch, and only for Training', () => {
    expect(files.sms).toMatch(/if \(delivery\.action !== "send"\) \{\n\s*await finishAiAttentionCheck\(check\);\n\s*if \(delivery\.mode === "training"\) \{\n\s*queueShadowDraft\(/);
    expect(files.webchat).toMatch(/if \(delivery\.action !== 'send'\) \{\n\s*await finishAiAttentionCheck\(check\);\n\s*if \(delivery\.mode === 'training'\) \{\n\s*queueShadowDraft\(/);
    expect(files.email).toMatch(/if \(delivery\.action !== 'send'\) \{\n\s*await finishAiAttentionCheck\(check\);\n\s*if \(delivery\.mode === 'training'\) queueShadowDraft\(/);
    for (const text of Object.values(files)) expect(text.match(/queueShadowDraft\(/g)).toHaveLength(1);
  });

  it('record attention skips only where screening held the live reply, and only for Training', () => {
    expect(files.sms.match(/if \((smsMode|screeningMode) === "training"\) queueShadowAttentionSkip\(/g)).toHaveLength(2);
    expect(files.webchat).toMatch(/if \(webchatMode === 'training'\) queueShadowAttentionSkip\(/);
    expect(files.email).toMatch(/if \(emailMode === 'training'\) queueShadowAttentionSkip\(shadowSource\);\n\s*return;/);
  });

  it('use the persisted inbound record as the stable source id', () => {
    expect(files.sms).toMatch(/sourceMessageId: check\.messageId,\n\s*sourceMessageModel: "CommunicationMessage"/);
    expect(files.webchat).toMatch(/sourceMessageId: check\.messageId,\n\s*sourceMessageModel: 'WebChatMessage'/);
    expect(files.email).toMatch(/sourceMessageId: String\(lead\._id\),\n\s*sourceMessageModel: 'Lead'/);
  });
});
