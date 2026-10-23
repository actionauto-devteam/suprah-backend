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
const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.VEHICLE_REENGAGEMENT_CLASSIFIER_TIMEOUT_MS = '50';

const mockOrganizationFindById = jest.fn();
const mockLeadFind = jest.fn();
const mockLeadUpdateOne = jest.fn();
const mockLogCreate = jest.fn();
const mockIsSmsOptedOut = jest.fn();
const mockSendAutomatedSms = jest.fn();
const mockConversationFindOne = jest.fn();

jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrganizationFindById },
}));
jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { find: mockLeadFind, updateOne: mockLeadUpdateOne },
}));
jest.mock('../../src/models/VehicleReengagementLog.model', () => ({
  __esModule: true,
  default: { create: mockLogCreate },
}));
jest.mock('../../src/models/communication.model', () => ({
  Conversation: { findOne: mockConversationFindOne },
}));
jest.mock('../../src/services/communication.service', () => ({
  isSmsOptedOut: mockIsSmsOptedOut,
  sendAutomatedSms: mockSendAutomatedSms,
}));
const mockDecideAiDelivery = jest.fn();
jest.mock('../../src/services/aiOperatingMode.service', () => ({
  ...jest.requireActual('../../src/services/aiOperatingMode.service'),
  decideAiDelivery: mockDecideAiDelivery,
}));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: jest.fn().mockResolvedValue({ enabled: true, agentName: 'Anna' }),
}));

import mongoose from 'mongoose';
import { processLeadForVehicle } from '../../src/services/vehicleReengagement.service';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';

const HOUR = 60 * 60 * 1000;
const PHONE = '385-336-5062';
const civicArrival = { _id: 'veh-civic', organizationId: 'org-1', year: 2022, make: 'Honda', modelName: 'Civic', trim: 'Sport' } as any;

const civicLead = { _id: 'lead-civic', organizationId: 'org-1', firstName: 'Test', phone: PHONE, vehicle: { year: '2022', make: 'Honda', model: 'Civic' }, createdAt: new Date(), updatedAt: new Date() };
const civicDuplicate = { ...civicLead, _id: 'lead-civic-dup' };
const jeepLead = { _id: 'lead-jeep', organizationId: 'org-1', firstName: 'Test', phone: PHONE, vehicle: { year: '2022', make: 'Jeep', model: 'Grand Cherokee 4xe' }, createdAt: new Date(), updatedAt: new Date() };

let modelSpy: jest.SpiedFunction<typeof mongoose.model>;

function seedSiblings(siblings: any[]) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maxTimeMS: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(siblings),
  };
  modelSpy = jest.spyOn(mongoose, 'model').mockReturnValue({ find: jest.fn().mockReturnValue(chain) } as any);
}

function seedSharedConversationActivity(lastMessageAt: Date | null) {
  mockConversationFindOne.mockReturnValue({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(lastMessageAt ? { lastMessageAt } : null) })),
  });
}

function seedMatchingLeads(leads: any[]) {
  mockLeadFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(leads) })) })) });
}

function seedSafeGeneration() {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: "Hi Test, this is Anna with Action Auto — a 2022 Honda Civic just arrived like the one you asked about. Want to come take a look?" } }],
  });
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrganizationFindById.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Action Auto' }) })) });
  mockIsSmsOptedOut.mockResolvedValue(false);
  mockSendAutomatedSms.mockResolvedValue(true);
  mockLeadUpdateOne.mockResolvedValue({});
  mockLogCreate.mockResolvedValue({});
});

afterEach(() => modelSpy?.mockRestore());

describe('vehicle re-engagement — operating mode', () => {
  it('when SMS AI is not live, records a distinct not-live outcome and never generates, checks opt-out, or texts', async () => {
    mockDecideAiDelivery.mockResolvedValue({ action: 'skip', mode: 'training', source: 'configured' });
    await processLeadForVehicle(civicLead, civicArrival);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockIsSmsOptedOut).not.toHaveBeenCalled();
    expect(mockSendAutomatedSms).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-civic',
      vehicleId: 'veh-civic',
      status: 'skipped_ai_not_live',
    }));
    expect(mockLeadUpdateOne).not.toHaveBeenCalled();
  });

  it('asks about the exact lead and phone so only a genuine demo lead can be simulated', async () => {
    mockDecideAiDelivery.mockResolvedValue({ action: 'skip', mode: 'training', source: 'configured' });
    await processLeadForVehicle(civicLead, civicArrival);
    expect(mockDecideAiDelivery).toHaveBeenCalledWith({
      organizationId: 'org-1', channel: 'sms', workflow: 'vehicle_reengagement', toPhone: PHONE, leadId: 'lead-civic',
    });
  });

  it('when live, sends through the guarded system path tagged as AI re-engagement', async () => {
    mockDecideAiDelivery.mockResolvedValue({ action: 'send', mode: 'live', source: 'configured' });
    seedSiblings([civicLead]);
    seedSharedConversationActivity(null);
    seedSafeGeneration();
    await processLeadForVehicle(civicLead, civicArrival);
    expect(mockSendAutomatedSms).toHaveBeenCalledWith(expect.objectContaining({ aiWorkflow: 'vehicle_reengagement', leadId: 'lead-civic' }));
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  it('if the mode leaves Live after generation, logs not-live with the draft and does not count it as outreach', async () => {
    mockDecideAiDelivery.mockResolvedValue({ action: 'send', mode: 'live', source: 'configured' });
    mockSendAutomatedSms.mockRejectedValue(new AiReplySuppressedError());
    seedSiblings([civicLead]);
    seedSharedConversationActivity(null);
    seedSafeGeneration();
    await processLeadForVehicle(civicLead, civicArrival);
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped_ai_not_live',
      generatedMessage: expect.stringContaining('Civic'),
    }));
    expect(mockLogCreate).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
    expect(mockLeadUpdateOne).not.toHaveBeenCalled();
  });
});
