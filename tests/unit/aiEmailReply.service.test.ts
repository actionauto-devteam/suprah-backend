jest.mock('../../src/services/contactRestriction.service', () => ({
  ...jest.requireActual('../../src/services/contactRestriction.service'),
  resolveContactRestriction: jest.fn(async () => ({ status: 'allowed' })),
  checkContactForSend: jest.fn(async () => ({ status: 'allowed' })),
  assertContactAllowed: jest.fn(async () => undefined),
  authorizeWebchatReply: jest.fn(async () => ({ allowed: true, basis: 'not_restricted' })),
  assertWebchatReplyAllowed: jest.fn(async () => ({ allowed: true, basis: 'not_restricted' })),
  recordWebchatExceptionReply: jest.fn(async () => undefined),
  recordContactRestrictionAudit: jest.fn(async () => true),
  describeWebchatContactPolicy: jest.fn(async () => ({ restricted: false, lookupUnavailable: false, restrictedSince: null, windowMinutes: 30 })),
  isOrganizationAdmin: jest.fn(async () => false),
  protectPreviousContact: jest.fn(async () => ({})),
  releaseProtectedContacts: jest.fn(async () => undefined),
}));
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
const mockAiAgentLogCreate = jest.fn().mockResolvedValue({});
const mockLoadReplyKnowledge = jest.fn().mockResolvedValue([]);
const mockSelectRelevantKnowledge = jest.fn().mockResolvedValue([]);

jest.mock('../../src/models/AiAgentLog.model', () => ({
  __esModule: true,
  default: { create: mockAiAgentLogCreate },
}));

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
jest.mock('../../src/utils/vehicleMatch', () => ({
  matchesVehicle: mockMatchesVehicle,
}));
jest.mock('../../src/services/aiOperatingMode.service', () => require('./helpers/legacyAiModeMock').legacyAiModeMock((orgId: any) => mockResolveAiAgentSettings(orgId)));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: mockResolveAiAgentSettings,
  generateAlexEmailReply: mockGenerateAlexEmailReply,
  classifyAlexEmailReplySafety: mockClassifyAlexEmailReplySafety,
  selectRelevantKnowledge: mockSelectRelevantKnowledge,
}));
jest.mock('../../src/services/aiKnowledgeRuntime.service', () => ({
  loadReplyKnowledge: mockLoadReplyKnowledge,
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
import { GENERIC_FALLBACK_MESSAGES } from '../../src/utils/aiFallbackMessage';
import { buildReplyAllowance } from '../../src/utils/aiOutboundSafety';

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

  it('allows an amount, phone number and link only when they come from an approved Knowledge Base answer', () => {
    const allowance = buildReplyAllowance({ moneyNotes: [], approvedAnswers: ['Our documentation fee is $299. Call 801-555-0100 or visit actionautoutah.com for details.'] });
    const reply = 'Our documentation fee is $299, and you can call 801-555-0100 or visit actionautoutah.com.';
    expect(validateOutboundEmailMessage(reply, [], allowance).ok).toBe(true);
    expect(validateOutboundEmailMessage(reply).ok).toBe(false);
    const otherAmount = validateOutboundEmailMessage('Our documentation fee is $399 this month for you.', [], allowance);
    expect(otherAmount.ok).toBe(false);
    expect(otherAmount.reasons).toContain('unverified price figure');
    expect(validateOutboundEmailMessage('Call 801-555-0199 for the documentation fee details today.', [], allowance).reasons).toContain('unexpected phone number');
    expect(validateOutboundEmailMessage('The $299 fee applies and this car is still available, hurry!', [], allowance).reasons).toContain('guaranteed-availability language');
  });

  it('still allows the confirmed vehicle price next to an approved amount', () => {
    const allowance = buildReplyAllowance({ moneyNotes: [], approvedAnswers: ['The documentation fee is $299.'] });
    expect(validateOutboundEmailMessage('The Civic is listed at $21,695 and the documentation fee is $299.', [21695], allowance).ok).toBe(true);
  });

  it('lets the words of an approved financing answer through, but not discount language it does not use', () => {
    const allowance = buildReplyAllowance({ moneyNotes: [], approvedAnswers: ['We work with several local banks and credit unions for financing.'] });
    expect(validateOutboundEmailMessage('We work with several local banks and credit unions for financing, and the team can walk you through it.', [], allowance).ok).toBe(true);
    expect(validateOutboundEmailMessage('We have financing and a special discount this week for you.', [], allowance).reasons).toContain('discount/incentive language');
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

  it('skips Alex without generating or sending when the only email is the lead-source address', async () => {
    await triggerAiEmailReplyForNewInquiry('org-1', { ...lead, email: 'leads@dealerscloud.com' }, 'Interested in the Volvo');
    expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
    expect(mockClaimAiGeneration).not.toHaveBeenCalled();
    expect(mockGenerateAlexEmailReply).not.toHaveBeenCalled();
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

  it('in Training mode, still runs the customer-attention check but never generates or emails', async () => {
    const modeMock = jest.requireMock('../../src/services/aiOperatingMode.service');
    modeMock.resolveAiChannelMode.mockResolvedValueOnce({ mode: 'training', source: 'configured' });
    modeMock.decideAiDelivery.mockResolvedValueOnce({ action: 'skip', mode: 'training', source: 'configured' });
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockScreenAiHumanAttention).toHaveBeenCalledTimes(1);
    expect(modeMock.decideAiDelivery).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', workflow: 'email_reply' }));
    expect(mockClaimAiGeneration).not.toHaveBeenCalled();
    expect(mockGenerateAlexEmailReply).not.toHaveBeenCalled();
    expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
    expect(mockFinishAiAttentionCheck).toHaveBeenCalled();
  });

  it('passes a dispatch guard that re-checks the email mode right before Gmail', async () => {
    const modeMock = jest.requireMock('../../src/services/aiOperatingMode.service');
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    const options = mockSendLeadReplyEmail.mock.calls[0][6];
    modeMock.assertAiDispatchAllowed.mockClear();
    await options.beforeDispatch();
    expect(modeMock.assertAiDispatchAllowed).toHaveBeenCalledWith({
      organizationId: 'org-1', channel: 'email', workflow: 'email_reply', leadId: 'lead-1',
    });
  });

  it('if the mode leaves Live while the email is being written, nothing is sent and no fallback is attempted', async () => {
    const { AiReplySuppressedError } = jest.requireActual('../../src/utils/aiReplySuppressed');
    mockSendLeadReplyEmail.mockRejectedValueOnce(new AiReplySuppressedError());
    await expect(triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo')).resolves.toBeUndefined();
    expect(mockSendLeadReplyEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateAiAgentTaskAndNotify).not.toHaveBeenCalled();
    expect(mockFinishAiAttentionCheck).toHaveBeenCalled();
  });

  it('skips a Do Not Contact customer before generating anything and records why', async () => {
    const restriction = jest.requireMock('../../src/services/contactRestriction.service');
    restriction.checkContactForSend.mockImplementationOnce(async () => ({ status: 'restricted', leadIds: ['lead-old'], onThisLead: false }));
    await triggerAiEmailReplyForNewInquiry('org-1', { ...lead, customerId: 'cust-1' }, 'Interested in the Volvo');
    expect(restriction.checkContactForSend).toHaveBeenCalledWith({
      organizationId: 'org-1', leadId: 'lead-1', email: 'kaitlyn@example.com', phone: undefined, customerId: 'cust-1',
    }, expect.objectContaining({ channel: 'email', purpose: 'alex_email_reply' }));
    expect(mockClaimAiGeneration).not.toHaveBeenCalled();
    expect(mockGenerateAlexEmailReply).not.toHaveBeenCalled();
    expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
    expect(mockFinishAiAttentionCheck).toHaveBeenCalled();
    expect(mockAiAgentLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', leadId: 'lead-1', status: 'skipped', failureReason: expect.stringContaining('(do_not_contact)'),
    }));
  });

  it('records a skip, with no fallback or handoff, when the email send boundary finds the customer is Do Not Contact', async () => {
    const { ContactRestrictedError } = jest.requireActual('../../src/services/contactRestriction.service');
    mockSendLeadReplyEmail.mockRejectedValueOnce(new ContactRestrictedError({ status: 'restricted', leadIds: ['lead-1'], onThisLead: true }));
    await expect(triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo')).resolves.toBeUndefined();
    expect(mockSendLeadReplyEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateAiAgentTaskAndNotify).not.toHaveBeenCalled();
    expect(mockFinishAiAttentionCheck).toHaveBeenCalled();
    expect(mockAiAgentLogCreate).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', status: 'skipped' }));
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
      { beforeDispatch: expect.any(Function), requireVerifiedRecipient: true },
    );
  });

  it('uses approved Knowledge Base answers for the email reply and lets their exact amount through', async () => {
    const answer = { id: 'kb-1', kind: 'faq', topic: 'documents_required', title: 'Doc fee', question: 'What is the doc fee?', answer: 'Our documentation fee is $299.', approvedAmounts: ['$299'] };
    const draft = 'Hi Kaitlyn, our documentation fee is $299, and I will confirm the rest with the team.';
    const asked = [{ from: 'customer', body: 'What is your doc fee on the Volvo?' }];
    mockLoadReplyKnowledge.mockResolvedValueOnce([answer]);
    mockSelectRelevantKnowledge.mockResolvedValueOnce([answer]);
    mockGenerateAlexEmailReply.mockResolvedValueOnce({ text: draft });

    await triggerAiEmailReplyForNewInquiry('org-1', { ...lead, location: 'Lehi' }, 'What is your doc fee on the Volvo?');

    expect(mockLoadReplyKnowledge).toHaveBeenCalledWith({ organizationId: 'org-1', channel: 'email', location: 'Lehi', transcript: asked });
    expect(mockSelectRelevantKnowledge).toHaveBeenCalledWith(expect.objectContaining({ candidates: [answer], channel: 'email', transcript: asked }));
    expect(mockGenerateAlexEmailReply).toHaveBeenCalledWith(expect.objectContaining({ knowledge: [answer], approvedAmounts: ['$299'], transcript: asked }));
    expect(mockClassifyAlexEmailReplySafety).toHaveBeenCalledWith(draft, undefined, expect.objectContaining({ keys: ['usd:299'] }));
    expect(mockSendLeadReplyEmail).toHaveBeenCalledTimes(1);
    expect(mockSendLeadReplyEmail.mock.calls[0][1]).toBe(draft);
    expect(mockCreateAiAgentTaskAndNotify).not.toHaveBeenCalled();
  });

  it('without a fitting Knowledge Base answer, an amount in the email is still blocked and a safe fallback goes out', async () => {
    const draft = 'Hi Kaitlyn, our documentation fee is $299 for this one.';
    mockGenerateAlexEmailReply.mockResolvedValueOnce({ text: draft });

    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'What is your doc fee?');

    expect(mockLoadReplyKnowledge).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }));
    expect(mockSelectRelevantKnowledge).not.toHaveBeenCalled();
    expect(mockGenerateAlexEmailReply).toHaveBeenCalledWith(expect.objectContaining({ knowledge: [], approvedAmounts: undefined }));
    expect(mockClassifyAlexEmailReplySafety).not.toHaveBeenCalled();
    expect(mockSendLeadReplyEmail.mock.calls.map((call: any[]) => call[1])).not.toContain(draft);
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

  it('sends a safe fallback (never the blocked draft) when the deterministic validator blocks the draft', async () => {
    mockGenerateAlexEmailReply.mockResolvedValue({ text: 'The price is $99,999 for this one, act fast!' });
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockClassifyAlexEmailReplySafety).not.toHaveBeenCalled();
    expect(mockSendLeadReplyEmail).toHaveBeenCalledWith(
      lead,
      GENERIC_FALLBACK_MESSAGES[0],
      'ai-agent',
      'org-1',
      [],
      'actionautoutah.dev@gmail.com',
      { beforeDispatch: expect.any(Function), requireVerifiedRecipient: true },
    );
    expect(mockCreateAiAgentTaskAndNotify).toHaveBeenCalled();
    expect(mockAddLeadNoteAndNotify).toHaveBeenCalled();
  });

  it('sends a safe fallback (never the blocked draft) when the email safety classifier returns UNSAFE', async () => {
    mockClassifyAlexEmailReplySafety.mockResolvedValue('UNSAFE');
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');
    expect(mockSendLeadReplyEmail).toHaveBeenCalledWith(
      lead,
      GENERIC_FALLBACK_MESSAGES[0],
      'ai-agent',
      'org-1',
      [],
      'actionautoutah.dev@gmail.com',
      { beforeDispatch: expect.any(Function), requireVerifiedRecipient: true },
    );
    expect(mockCreateAiAgentTaskAndNotify).toHaveBeenCalled();
    expect(mockAddLeadNoteAndNotify).toHaveBeenCalled();
  });

  it('acknowledges a specific test-drive request in the email fallback, naming this inquiry\'s vehicle only', async () => {
    mockClassifyAlexEmailReplySafety.mockResolvedValue('UNSAFE');
    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Can I test drive it Saturday at 11am?');
    expect(mockSendLeadReplyEmail).toHaveBeenCalledWith(
      lead,
      'Thanks for your test drive request for the 2023 Volvo XC40! A member of our team will follow up to confirm whether Saturday at 11 AM works.',
      'ai-agent',
      'org-1',
      [],
      'actionautoutah.dev@gmail.com',
      { beforeDispatch: expect.any(Function), requireVerifiedRecipient: true },
    );
  });

  function leadModelWithSiblings(siblings: any[]) {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(siblings),
    };
    mongooseModelSpy.mockImplementation((name: any) => {
      if (name === 'Lead') {
        return { findOneAndUpdate: mockLeadFindOneAndUpdate, updateOne: mockLeadUpdateOne, find: jest.fn().mockReturnValue(chain) } as any;
      }
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });
  }

  it('pins the email reply to this inquiry and tells the model not to mention the customer\'s other vehicle inquiry', async () => {
    const civicInquiry = { _id: 'lead-2', email: lead.email, vehicle: { year: '2022', make: 'Honda', model: 'Civic' }, updatedAt: new Date() };
    leadModelWithSiblings([lead, civicInquiry]);

    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');

    const call = mockGenerateAlexEmailReply.mock.calls[0][0];
    expect(call.leadVehicleInterest).toBe('2023 Volvo XC40');
    expect(call.vehicleContextNote).toContain('This message is about the 2023 Volvo XC40 only');
    expect(call.vehicleContextNote).toContain('2022 Honda Civic');
  });

  it('leaves single-inquiry email replies unchanged (no extra vehicle instruction)', async () => {
    leadModelWithSiblings([lead]);

    await triggerAiEmailReplyForNewInquiry('org-1', lead, 'Interested in the Volvo');

    expect(mockGenerateAlexEmailReply.mock.calls[0][0].vehicleContextNote).toBeUndefined();
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
