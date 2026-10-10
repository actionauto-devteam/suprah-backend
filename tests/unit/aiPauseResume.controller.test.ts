const mockConvFindOneAndUpdate = jest.fn();
const mockSessionFindOneAndUpdate = jest.fn();
const mockEmit = jest.fn();

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: { findOneAndUpdate: mockConvFindOneAndUpdate },
  CommunicationMessage: {},
  CallLog: {},
}));
jest.mock('../../src/models/WebChatSession.model', () => ({
  __esModule: true,
  default: { findOneAndUpdate: mockSessionFindOneAndUpdate },
}));
const mockSendSmsFromUser = jest.fn();
jest.mock('../../src/services/communication.service', () => ({ sendSmsFromUser: mockSendSmsFromUser }));
jest.mock('../../src/services/telnyx.service', () => ({}));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/WebChatMessage.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/MailConversation.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/MailMessage.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/aiAutoPause', () => ({ recordHumanTakeover: jest.fn() }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: mockEmit }));

process.env.GEMINI_API_KEY = 'test-key';

import { pauseSmsAi, resumeSmsAi, sendMessage, actor } from '../../src/controllers/communication.controller';
import { pauseWebchatAi, resumeWebchatAi } from '../../src/controllers/webchat.controller';

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  fn(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, next };
}

describe('AI pause/resume — auto-pause interaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1' });
    mockSessionFindOneAndUpdate.mockResolvedValue({ _id: 'sess-1', leadId: 'lead-1' });
  });

  it('pauseSmsAi clears aiAutoPausedUntil in the same update that sets aiPausedAt', async () => {
    const req = { params: { leadId: 'lead-1' }, orgId: 'org-1', user: { _id: 'u1', name: 'Erik' } };
    await invoke(pauseSmsAi, req);

    const [, update] = mockConvFindOneAndUpdate.mock.calls[0];
    expect(update.$set.aiPausedAt).toBeInstanceOf(Date);
    expect(update.$set.aiPausedBy).toEqual({ userId: 'u1', name: 'Erik' });
    expect(update.$unset).toEqual({ aiAutoPausedUntil: '' });
  });

  it("resumeSmsAi's $unset includes aiAutoPausedUntil alongside aiPausedAt/aiPausedBy", async () => {
    const req = { params: { leadId: 'lead-1' }, orgId: 'org-1', user: { _id: 'u1' } };
    await invoke(resumeSmsAi, req);

    const [, update] = mockConvFindOneAndUpdate.mock.calls[0];
    expect(update.$unset).toEqual({ aiPausedAt: '', aiPausedBy: '', aiAutoPausedUntil: '', aiHumanAttention: '', aiAttentionPendingIds: '' });
    expect(update.$inc.aiResponseVersion).toBe(1);
  });

  it('pauseWebchatAi clears aiAutoPausedUntil in the same update that sets aiPausedAt', async () => {
    const req = {
      params: { leadId: '507f1f77bcf86cd799439011' },
      orgId: 'org-1',
      user: { _id: 'u1', name: 'Erik' },
    };
    await invoke(pauseWebchatAi, req);

    const [, update] = mockSessionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.aiPausedAt).toBeInstanceOf(Date);
    expect(update.$set.aiPausedBy).toEqual({ userId: 'u1', name: 'Erik' });
    expect(update.$unset).toEqual({ aiAutoPausedUntil: '' });
  });

  it("resumeWebchatAi's $unset includes aiAutoPausedUntil alongside aiPausedAt/aiPausedBy", async () => {
    const req = { params: { leadId: '507f1f77bcf86cd799439011' }, orgId: 'org-1', user: { _id: 'u1' } };
    await invoke(resumeWebchatAi, req);

    const [, update] = mockSessionFindOneAndUpdate.mock.calls[0];
    expect(update.$unset).toEqual({ aiPausedAt: '', aiPausedBy: '', aiAutoPausedUntil: '', aiHumanAttention: '', aiAttentionPendingIds: '' });
    expect(update.$inc.aiResponseVersion).toBe(1);
  });

  it.each([resumeSmsAi, resumeWebchatAi])('rejects unauthenticated resume', async (fn) => {
    const { next } = await invoke(fn, { params: { leadId: '507f1f77bcf86cd799439011' }, orgId: 'org-1' });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

describe('actor() — staff display-name resolution', () => {
  it('resolves a CrmUser session (fullName only, no name/firstName/lastName) to its fullName, not its email', () => {
    const req: any = { crmUser: { _id: 'crm-1', fullName: 'Dev Admin', email: 'dev-0001@local.test' } };
    expect(actor(req)).toEqual({ userId: 'crm-1', name: 'Dev Admin', email: 'dev-0001@local.test' });
  });

  it('a User session with .name is unaffected by the fix (existing behavior preserved)', () => {
    const req: any = { user: { _id: 'u1', name: 'Erik Schofield', email: 'erik@example.com' } };
    expect(actor(req)).toEqual({ userId: 'u1', name: 'Erik Schofield', email: 'erik@example.com' });
  });

  it('a User session with only firstName/lastName is unaffected by the fix (existing behavior preserved)', () => {
    const req: any = { user: { _id: 'u2', firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com' } };
    expect(actor(req)).toEqual({ userId: 'u2', name: 'Jordan Lee', email: 'jordan@example.com' });
  });

  it('falls back to a trimmed email when name/fullName/firstName/lastName are all empty or whitespace-only', () => {
    const req: any = { crmUser: { _id: 'crm-2', fullName: '   ', email: '  someone@example.com  ' } };
    expect(actor(req)).toEqual({ userId: 'crm-2', name: 'someone@example.com', email: '  someone@example.com  ' });
  });

  it('falls back to "Team member" — never "undefined" or a blank string — when nothing is present at all', () => {
    const req: any = { crmUser: { _id: 'crm-3' } };
    const result = actor(req);
    expect(result.name).toBe('Team member');
    expect(result.name).not.toMatch(/undefined/i);
    expect(result.name.trim().length).toBeGreaterThan(0);
  });

  it('falls back to "Team member" when every candidate field is present but blank/whitespace, including email', () => {
    const req: any = { crmUser: { _id: 'crm-4', fullName: '', name: '', email: '   ' } };
    const result = actor(req);
    expect(result.name).toBe('Team member');
  });

  it('prefers name/fullName/firstName+lastName over email even when email is present (no behavior change for the common case)', () => {
    const req: any = { crmUser: { _id: 'crm-5', fullName: 'Pilot Recon', email: 'pilot@example.com' } };
    expect(actor(req).name).toBe('Pilot Recon');
  });

  it('staff-authored SMS attribution (sendMessage) uses the resolved CrmUser fullName, not the email, matching the pause-attribution fix', async () => {
    mockSendSmsFromUser.mockResolvedValue({
      message: { _id: 'msg-1' },
      conversation: { _id: 'conv-1', leadId: 'lead-1' },
    });
    const req: any = {
      orgId: 'org-1',
      crmUser: { _id: 'crm-1', fullName: 'Dev Admin', email: 'dev-0001@local.test' },
      body: { toPhone: '+18015550142', body: 'hello', leadId: 'lead-1' },
    };
    await invoke(sendMessage, req);

    expect(mockSendSmsFromUser).toHaveBeenCalledWith(
      expect.objectContaining({ user: { userId: 'crm-1', name: 'Dev Admin', email: 'dev-0001@local.test' } }),
    );
  });

  it('pauseSmsAi records the CrmUser fullName (not the email) as aiPausedBy.name — the originally reported bug', async () => {
    const req: any = {
      params: { leadId: 'lead-1' },
      orgId: 'org-1',
      crmUser: { _id: 'crm-1', fullName: 'Dev Admin', email: 'dev-0001@local.test' },
    };
    await invoke(pauseSmsAi, req);

    const [, update] = mockConvFindOneAndUpdate.mock.calls[0];
    expect(update.$set.aiPausedBy).toEqual({ userId: 'crm-1', name: 'Dev Admin' });
  });
});
