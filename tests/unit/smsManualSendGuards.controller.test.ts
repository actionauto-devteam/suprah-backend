const mockConvFindOne = jest.fn();
const mockLeadExists = jest.fn();
const mockSendSmsFromUser = jest.fn();
const mockIsSmsOptedOut = jest.fn();
const mockGetThreadByPhone = jest.fn();
const mockRecordHumanTakeover = jest.fn();

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: { findOne: mockConvFindOne, findOneAndUpdate: jest.fn() },
  CommunicationMessage: {},
  CallLog: {},
}));
jest.mock('../../src/services/communication.service', () => ({
  sendSmsFromUser: mockSendSmsFromUser,
  isSmsOptedOut: mockIsSmsOptedOut,
  getThreadByPhone: mockGetThreadByPhone,
}));
jest.mock('../../src/services/telnyx.service', () => ({}));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { exists: mockLeadExists } }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/WebChatMessage.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/MailConversation.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/MailMessage.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/aiAutoPause', () => ({ recordHumanTakeover: mockRecordHumanTakeover }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn() }));

process.env.GEMINI_API_KEY = 'test-key';

import { sendMessage, replyToConversation, getThreadByPhone } from '../../src/controllers/communication.controller';

const LEAD_ID = '64b7f0c2a1b2c3d4e5f60718';

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  fn(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next, error: next.mock.calls[0]?.[0] };
}

function smsRequest(body: Record<string, unknown>) {
  return { orgId: 'org-1', crmUser: { _id: 'crm-1', fullName: 'Dev Admin' }, body };
}

describe('manual SMS send guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSmsOptedOut.mockResolvedValue(false);
    mockLeadExists.mockResolvedValue({ _id: LEAD_ID });
    mockSendSmsFromUser.mockResolvedValue({ message: { _id: 'msg-1' }, conversation: { _id: 'conv-1', leadId: LEAD_ID } });
  });

  it('rejects a phone number that is too short to text', async () => {
    const { error } = await invoke(sendMessage, smsRequest({ toPhone: '555-12', body: 'hi' }));
    expect(error?.statusCode).toBe(400);
    expect(mockSendSmsFromUser).not.toHaveBeenCalled();
  });

  it('rejects a leadId that is not a valid id', async () => {
    const { error } = await invoke(sendMessage, smsRequest({ toPhone: '+13855035869', body: 'hi', leadId: 'not-an-id' }));
    expect(error?.statusCode).toBe(404);
    expect(mockLeadExists).not.toHaveBeenCalled();
    expect(mockSendSmsFromUser).not.toHaveBeenCalled();
  });

  it('rejects a leadId that belongs to another organization', async () => {
    mockLeadExists.mockResolvedValue(null);
    const { error } = await invoke(sendMessage, smsRequest({ toPhone: '+13855035869', body: 'hi', leadId: LEAD_ID }));
    expect(mockLeadExists).toHaveBeenCalledWith({ _id: LEAD_ID, organizationId: 'org-1' });
    expect(error?.statusCode).toBe(404);
    expect(mockSendSmsFromUser).not.toHaveBeenCalled();
  });

  it('blocks a manual text to a number with a confirmed STOP opt-out', async () => {
    mockIsSmsOptedOut.mockResolvedValue(true);
    const { error } = await invoke(sendMessage, smsRequest({ toPhone: '+13855035869', body: 'hi', leadId: LEAD_ID }));
    expect(mockIsSmsOptedOut).toHaveBeenCalledWith('org-1', '+13855035869');
    expect(error?.statusCode).toBe(403);
    expect(error?.errors).toEqual([{ code: 'SMS_OPTED_OUT' }]);
    expect(mockSendSmsFromUser).not.toHaveBeenCalled();
    expect(mockRecordHumanTakeover).not.toHaveBeenCalled();
  });

  it('sends normally and still records the human takeover for Alex', async () => {
    const { status, error } = await invoke(sendMessage, smsRequest({ toPhone: '(385) 503-5869', body: 'hi', leadId: LEAD_ID }));
    expect(error).toBeUndefined();
    expect(status).toHaveBeenCalledWith(201);
    expect(mockSendSmsFromUser).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', toPhone: '(385) 503-5869', leadId: LEAD_ID }));
    expect(mockRecordHumanTakeover).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sms', organizationId: 'org-1', leadId: LEAD_ID }));
  });

  it('sends without a leadId and never looks up a lead', async () => {
    const { error } = await invoke(sendMessage, smsRequest({ toPhone: '+13855035869', body: 'hi' }));
    expect(error).toBeUndefined();
    expect(mockLeadExists).not.toHaveBeenCalled();
    expect(mockSendSmsFromUser).toHaveBeenCalled();
  });

  it('blocks a conversation reply when the customer has opted out', async () => {
    mockConvFindOne.mockResolvedValue({ _id: 'conv-1', customerPhone: '+13855035869' });
    mockIsSmsOptedOut.mockResolvedValue(true);
    const { error } = await invoke(replyToConversation, { orgId: 'org-1', crmUser: { _id: 'crm-1' }, params: { id: 'conv-1' }, body: { body: 'hi' } });
    expect(error?.statusCode).toBe(403);
    expect(mockSendSmsFromUser).not.toHaveBeenCalled();
  });

  it('allows a conversation reply when there is no opt-out', async () => {
    mockConvFindOne.mockResolvedValue({ _id: 'conv-1', customerPhone: '+13855035869', leadId: LEAD_ID });
    const { error } = await invoke(replyToConversation, { orgId: 'org-1', crmUser: { _id: 'crm-1' }, params: { id: 'conv-1' }, body: { body: 'hi' } });
    expect(error).toBeUndefined();
    expect(mockSendSmsFromUser).toHaveBeenCalled();
  });

  it('reports the opt-out state with the thread so the composer can disable texting', async () => {
    mockGetThreadByPhone.mockResolvedValue({ conversation: { _id: 'conv-1' }, messages: [] });
    mockIsSmsOptedOut.mockResolvedValue(true);
    const { json } = await invoke(getThreadByPhone, { orgId: 'org-1', query: { phone: '+13855035869', leadId: LEAD_ID } });
    expect(json.mock.calls[0][0].data).toEqual({ conversation: { _id: 'conv-1' }, messages: [], smsOptedOut: true });
  });
});
