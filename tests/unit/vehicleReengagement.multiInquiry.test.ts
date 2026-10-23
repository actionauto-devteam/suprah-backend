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
jest.mock('../../src/services/aiOperatingMode.service', () => require('./helpers/legacyAiModeMock').legacyAiModeMock(async () => ({ enabled: true })));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: jest.fn().mockResolvedValue({ enabled: true, agentName: 'Anna' }),
}));

import mongoose from 'mongoose';
import { processLeadForVehicle, processVehicleForReengagement } from '../../src/services/vehicleReengagement.service';

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

describe('vehicle re-engagement — customers with multiple vehicle inquiries', () => {
  it('texts the same customer once when two of their leads match the same arriving vehicle', async () => {
    seedSiblings([civicLead, civicDuplicate]);
    seedSharedConversationActivity(null);
    seedMatchingLeads([civicLead, civicDuplicate]);
    seedSafeGeneration();

    await processVehicleForReengagement(civicArrival);

    expect(mockSendAutomatedSms).toHaveBeenCalledTimes(1);
    expect(mockSendAutomatedSms).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'lead-civic' }));
    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 'lead-civic-dup',
        status: 'skipped',
        failureReason: 'Same customer was already matched to this vehicle through another inquiry',
      }),
    );
  });

  it('leaves it for staff instead of texting mid-conversation when the customer has another open inquiry', async () => {
    seedSiblings([civicLead, jeepLead]);
    seedSharedConversationActivity(new Date(Date.now() - 2 * HOUR));

    await processLeadForVehicle(civicLead, civicArrival);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendAutomatedSms).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-civic', status: 'skipped', failureReason: expect.stringMatching(/left for staff/i) }),
    );
  });

  it('still sends when the customer has another inquiry but the shared thread has been quiet', async () => {
    seedSiblings([civicLead, jeepLead]);
    seedSharedConversationActivity(new Date(Date.now() - 5 * 24 * HOUR));
    seedSafeGeneration();

    await processLeadForVehicle(civicLead, civicArrival);

    expect(mockSendAutomatedSms).toHaveBeenCalledTimes(1);
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  it('keeps single-inquiry customers unchanged, even if their thread was active recently', async () => {
    seedSiblings([civicLead]);
    seedSharedConversationActivity(new Date(Date.now() - 2 * HOUR));
    seedSafeGeneration();

    await processLeadForVehicle(civicLead, civicArrival);

    expect(mockSendAutomatedSms).toHaveBeenCalledTimes(1);
  });

  it('still honors SMS opt-out before any of the new checks', async () => {
    mockIsSmsOptedOut.mockResolvedValue(true);
    seedSiblings([civicLead, jeepLead]);
    seedSharedConversationActivity(new Date(Date.now() - 2 * HOUR));

    await processLeadForVehicle(civicLead, civicArrival);

    expect(mockSendAutomatedSms).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', failureReason: 'Customer opted out of SMS' }));
  });

  it.each(['+639171234567', '385-336-5062 x7', '+385503586912'])(
    'logs a skipped re-engagement for the untextable number %p without generating or sending',
    async (phone) => {
      seedSiblings([{ ...civicLead, phone }]);
      seedSharedConversationActivity(null);

      await processLeadForVehicle({ ...civicLead, phone }, civicArrival);

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockSendAutomatedSms).not.toHaveBeenCalled();
      expect(mockLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: 'lead-civic', status: 'skipped', failureReason: expect.any(String) }),
      );
    },
  );
});
