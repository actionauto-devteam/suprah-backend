const mockLeadFindOneAndUpdate = jest.fn();
const mockLeadUpdateOne = jest.fn().mockResolvedValue({});
const mockVehicleFindOne = jest.fn();
const mockVehicleFind = jest.fn();
const mockOrgLeadConfigFindOne = jest.fn();
const mockOrganizationFindById = jest.fn();
const mockResolveAiAgentSettings = jest.fn();
const mockGenerateAlexEmailReply = jest.fn();
const mockClassifyAlexEmailReplySafety = jest.fn();
const mockBeginAiAttentionCheck = jest.fn();
const mockFinishAiAttentionCheck = jest.fn().mockResolvedValue(undefined);
const mockScreenAiHumanAttention = jest.fn();
const mockClaimAiGeneration = jest.fn();
const mockCreateAiAgentTaskAndNotify = jest.fn();
const mockAddLeadNoteAndNotify = jest.fn();
const mockShouldSuppressHandoffNoteNotification = jest.fn().mockReturnValue(false);
const mockSendLeadReplyEmail = jest.fn();
const mockFetchGmailThreadMessages = jest.fn().mockResolvedValue([]);
const mockMatchesVehicle = jest.fn().mockReturnValue(false);

jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findOne: mockVehicleFindOne, find: mockVehicleFind },
}));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({
  __esModule: true,
  default: { findOne: mockOrgLeadConfigFindOne },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrganizationFindById },
}));
jest.mock('../../src/services/vehicleReengagement.service', () => ({
  matchesVehicle: mockMatchesVehicle,
}));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: mockResolveAiAgentSettings,
  generateAlexEmailReply: mockGenerateAlexEmailReply,
  classifyAlexEmailReplySafety: mockClassifyAlexEmailReplySafety,
  ALEX_FALLBACK_MESSAGE: "Let me get someone from our team to help you with that — they'll be right with you!",
}));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: mockBeginAiAttentionCheck,
  finishAiAttentionCheck: mockFinishAiAttentionCheck,
  screenAiHumanAttention: mockScreenAiHumanAttention,
  claimAiGeneration: mockClaimAiGeneration,
}));
jest.mock('../../src/utils/aiAgentTask', () => ({
  createAiAgentTaskAndNotify: mockCreateAiAgentTaskAndNotify,
}));
jest.mock('../../src/utils/leadNote', () => ({
  addLeadNoteAndNotify: mockAddLeadNoteAndNotify,
  shouldSuppressHandoffNoteNotification: mockShouldSuppressHandoffNoteNotification,
}));
jest.mock('../../src/controllers/lead.controller', () => ({
  sendLeadReplyEmail: mockSendLeadReplyEmail,
  fetchGmailThreadMessages: mockFetchGmailThreadMessages,
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import mongoose from 'mongoose';
import { validateOutboundEmailMessage, triggerAiEmailReplyForNewInquiry } from '../../src/services/aiEmailReply.service';

describe('validateOutboundEmailMessage', () => {
  it('blocks percent-off language', () => {
    expect(validateOutboundEmailMessage('We can do 20% off this week').ok).toBe(false);
  });
  it('blocks discount/incentive language', () => {
    expect(validateOutboundEmailMessage('Ask about our special discount today').ok).toBe(false);
  });
  it('blocks financing/payment language', () => {
    expect(validateOutboundEmailMessage('Low monthly payment financing available').ok).toBe(false);
  });
  it('blocks trade-in mentions', () => {
    expect(validateOutboundEmailMessage('We will value your trade-in highly').ok).toBe(false);
  });
  it('blocks guaranteed-availability language', () => {
    expect(validateOutboundEmailMessage('This one is still available, hurry in!').ok).toBe(false);
  });
  it('blocks an unhedged availability claim even without urgency language', () => {
    const result = validateOutboundEmailMessage('Yes, it is still available for you.');
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('guaranteed-availability language');
  });
  it('allows a hedged "confirm if still available" reply, matching the system prompt instruction', () => {
    const result = validateOutboundEmailMessage(
      "Thanks for asking about the Audi! I'll check with the team to confirm if it is still available and follow up with you shortly.",
    );
    expect(result.ok).toBe(true);
  });
  it('blocks an unexpected phone number', () => {
    expect(validateOutboundEmailMessage('Call us at 801-244-7049 today, interested in this car').ok).toBe(false);
  });
  it('blocks an unexpected link', () => {
    expect(validateOutboundEmailMessage('Check it out at https://actionautoutah.com today please').ok).toBe(false);
  });
  it('blocks a too-short message', () => {
    expect(validateOutboundEmailMessage('hi').ok).toBe(false);
  });

  it('blocks a dollar amount that does not match any confirmed price', () => {
    const result = validateOutboundEmailMessage('The price is $25,000 for this vehicle right now', [21695]);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('unverified price figure');
  });

  it('allows a dollar amount that exactly matches a confirmed price', () => {
    const result = validateOutboundEmailMessage('The current price is $21,695 for this vehicle today', [21695]);
    expect(result.ok).toBe(true);
  });

  it('allows a dollar amount matching a confirmed price even with comma/decimal formatting differences', () => {
    const result = validateOutboundEmailMessage('It is listed at $21695.00 right now for you', [21695]);
    expect(result.ok).toBe(true);
  });

  it('passes a normal benign message with no price mentioned at all', () => {
    const result = validateOutboundEmailMessage('Hi Jordan, happy to share more details about the Civic whenever works for you.');
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });
});

describe('triggerAiEmailReplyForNewInquiry', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;
  const lead = { _id: 'lead-1', organizationId: 'org-1', firstName: 'Kaitlyn', email: 'kaitlyn@example.com', vehicle: { year: '2023', make: 'Volvo', model: 'XC40' } };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLeadFindOneAndUpdate.mockResolvedValue({ _id: 'lead-1' });
    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') return { findOneAndUpdate: mockLeadFindOneAndUpdate, updateOne: mockLeadUpdateOne } as any;
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });
    mockBeginAiAttentionCheck.mockResolvedValue({ organizationId: 'org-1', channel: 'email', targetId: 'lead-1', messageId: 'msg-1', version: 1 });
    mockScreenAiHumanAttention.mockResolvedValue(true);
    mockClaimAiGeneration.mockResolvedValue({ aiGeneratingAt: new Date() });
    mockOrganizationFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Action Auto', metadata: {} }) }) });
    mockOrgLeadConfigFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ gmailAddress: 'actionautoutah.dev@gmail.com' }) }) });
    mockVehicleFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockVehicleFind.mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    mockGenerateAlexEmailReply.mockResolvedValue({ text: 'Hi Kaitlyn, happy to help with your Volvo XC40 inquiry.' });
    mockClassifyAlexEmailReplySafety.mockResolvedValue('SAFE');
    mockSendLeadReplyEmail.mockResolvedValue(undefined);
    mockCreateAiAgentTaskAndNotify.mockResolvedValue({ notified: true });
    mockAddLeadNoteAndNotify.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
  });

  it('does nothing when the lead has a usable phone number (SMS takes priority)', async () => {
    await triggerAiEmailReplyForNewInquiry('org-1', { ...lead, phone: '+18015550142' }, 'Interested in the Volvo');
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
  });

  it('does nothing when the lead has no email address', async () => {
    await triggerAiEmailReplyForNewInquiry('org-1', { ...lead, email: undefined }, 'Interested in the Volvo');
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when the inquiry text is empty', async () => {
    await triggerAiEmailReplyForNewInquiry('org-1', lead, '   ');
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('claims atomically on Lead.aiFirstReplyTriggeredAt — a lost claim is a no-op', async () => {
    mockLeadFindOneAndUpdate.mockResolvedValueOnce(null);
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockLeadFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'lead-1', organizationId: 'org-1', aiFirstReplyTriggeredAt: null },
      { $set: { aiFirstReplyTriggeredAt: expect.any(Date) } },
    );
    expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
  });

  it('never calls the Alex pipeline at all when Alex is disabled for the org', async () => {
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockScreenAiHumanAttention).not.toHaveBeenCalled();
  });

  it('on a clean happy path, sends the generated reply via sendLeadReplyEmail using the org central Gmail address', async () => {
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');

    expect(mockSendLeadReplyEmail).toHaveBeenCalledWith(
      lead,
      'Hi Kaitlyn, happy to help with your Volvo XC40 inquiry.',
      'ai-agent',
      'org-1',
      [],
      'actionautoutah.dev@gmail.com',
    );
  });

  it('passes the confirmed current price into generation when a matching vehicle with a price is found', async () => {
    mockVehicleFindOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });
    mockVehicleFind.mockReturnValueOnce({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ price: 21695, priceHistory: [{ previousPrice: 24000, newPrice: 21695 }] }]),
      }),
    });
    mockMatchesVehicle.mockReturnValueOnce(true);

    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');

    expect(mockGenerateAlexEmailReply).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedPrice: 21695, confirmedPreviousPrice: 24000 }),
    );
  });

  it('sends the fixed fallback (never the blocked draft) when the deterministic validator blocks the draft', async () => {
    mockGenerateAlexEmailReply.mockResolvedValue({ text: 'The price is $99,999 for this one, act fast!' });
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockClassifyAlexEmailReplySafety).not.toHaveBeenCalled();
    expect(mockSendLeadReplyEmail).toHaveBeenCalledWith(
      lead,
      "Let me get someone from our team to help you with that — they'll be right with you!",
      'ai-agent',
      'org-1',
      [],
      'actionautoutah.dev@gmail.com',
    );
    expect(mockCreateAiAgentTaskAndNotify).toHaveBeenCalled();
    expect(mockAddLeadNoteAndNotify).toHaveBeenCalled();
  });

  it('sends the fixed fallback (never the blocked draft) when the email safety classifier returns UNSAFE', async () => {
    mockClassifyAlexEmailReplySafety.mockResolvedValue('UNSAFE');
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockSendLeadReplyEmail).toHaveBeenCalledWith(
      lead,
      "Let me get someone from our team to help you with that — they'll be right with you!",
      'ai-agent',
      'org-1',
      [],
      'actionautoutah.dev@gmail.com',
    );
    expect(mockCreateAiAgentTaskAndNotify).toHaveBeenCalled();
    expect(mockAddLeadNoteAndNotify).toHaveBeenCalled();
  });

  it('on a handoff marker, creates an AI agent task and a mentioning note, and still sends the reply', async () => {
    mockGenerateAlexEmailReply.mockResolvedValue({ text: 'Let me check on that for you.', handoffReason: 'Confirm vehicle is on the lot' });
    await triggerAiEmailReplyForNewInquiry('org-1', { ...lead, assignedTo: 'rep-1' }, 'Is it still on the lot?');

    expect(mockSendLeadReplyEmail).toHaveBeenCalled();
    expect(mockCreateAiAgentTaskAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', question: 'Confirm vehicle is on the lot', assignedTo: 'rep-1' }),
    );
    expect(mockAddLeadNoteAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({ mentionedUserIds: ['rep-1'], authorType: 'ai' }),
    );
  });

  it('on a handoff with no assignee, falls back to the org-configured fallback group for the note mention', async () => {
    mockGenerateAlexEmailReply.mockResolvedValue({ text: 'Let me check on that for you.', handoffReason: 'Confirm vehicle is on the lot' });
    mockOrganizationFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Action Auto', metadata: { aiHandoffFallbackGroupId: 'group-1' } }) }) });

    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Is it still on the lot?');

    expect(mockAddLeadNoteAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({ mentionedUserIds: [], mentionedGroupIds: ['group-1'] }),
    );
  });

  it('on a milestone marker, writes a plain milestone note with no mentions and no task', async () => {
    mockGenerateAlexEmailReply.mockResolvedValue({ text: 'Great, see you Saturday!', milestoneNote: 'Customer confirmed a test drive' });
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Lets do Saturday');

    expect(mockCreateAiAgentTaskAndNotify).not.toHaveBeenCalled();
    expect(mockAddLeadNoteAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Customer confirmed a test drive', milestone: true }),
    );
  });

  it('never throws out of the function even when a downstream step rejects', async () => {
    mockSendLeadReplyEmail.mockRejectedValueOnce(new Error('gmail down'));
    await expect(triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo')).resolves.toBeUndefined();
  });
});
