const mockConvFindOne = jest.fn();

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: {
    findOne: mockConvFindOne,
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
  },
  CommunicationMessage: {
    findOne: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
    countDocuments: jest.fn().mockResolvedValue(0),
  },
  CallLog: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() },
  TelephonyCredential: {},
}));
jest.mock('../../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550000' }));
jest.mock('../../src/services/customerIdentity.service', () => ({ findUniqueCustomerByPhone: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/services/callRoutingConfig.service', () => ({ getInboundRoutingConfig: jest.fn().mockResolvedValue(null), getConfiguredInboundOrganization: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn().mockReturnValue(null) }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: jest.fn() }));
jest.mock('../../src/utils/aiAgentTask', () => ({ createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn(), shouldSuppressHandoffNoteNotification: jest.fn() }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({
  notificationTemplates: {
    new_lead: jest.fn().mockReturnValue({ title: 'New Lead', message: 'msg' }),
    appointment_confirmed_via_sms: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    appointment_reschedule_requested: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    appointment_reschedule_preference_received: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    sms_opt_out: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
  },
}));
jest.mock('../../src/models/SmsOptOut.model', () => ({ __esModule: true, default: { updateOne: jest.fn() } }));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: jest.fn(),
  processAlexTurn: jest.fn(),
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: jest.fn() }));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn(async (input: any) => ({ ...input, version: 1 })),
  finishAiAttentionCheck: jest.fn().mockResolvedValue(undefined),
  screenAiHumanAttention: jest.fn().mockResolvedValue(true),
  canSendAiReply: jest.fn().mockResolvedValue(true),
  assertAiReplyAllowed: jest.fn().mockResolvedValue(undefined),
  claimAiGeneration: jest.fn().mockResolvedValue(null),
  claimAiReplyDispatch: jest.fn().mockResolvedValue(undefined),
  attentionOrgIds: (id: string) => [id],
  recoverAiHumanAttention: jest.fn().mockResolvedValue(undefined),
  AiReplySuppressedError: class AiReplySuppressedError extends Error {},
}));
jest.mock('../../src/services/ivr.service', () => ({
  initializeIvr: jest.fn(),
  handleIvrGather: jest.fn(),
  emitIvrCall: jest.fn(),
  clearIvrTimer: jest.fn(),
  canReceiveIvrCall: jest.fn().mockResolvedValue(true),
  ivrAgentFailed: jest.fn(),
  recoverIvrCalls: jest.fn().mockResolvedValue(undefined),
}));

import { pickVariant, NURTURE_MESSAGES, buildReviewRequestMessage } from '../../src/services/communication.service';

describe('pickVariant', () => {
  it('is deterministic: the same seed always selects the same variant', () => {
    const variants = ['a', 'b', 'c'];
    const first = pickVariant(variants, 'lead-123');
    const second = pickVariant(variants, 'lead-123');
    expect(first).toBe(second);
  });

  it('distributes across the full variant set given a spread of seeds (no collapse to a single index)', () => {
    const variants = ['a', 'b'];
    const seeds = Array.from({ length: 50 }, (_, i) => `lead-${i}`);
    const results = new Set(seeds.map((seed) => pickVariant(variants, seed)));
    expect(results.size).toBe(2);
  });

  it('returns the only variant when just one exists', () => {
    expect(pickVariant(['only'], 'anything')).toBe('only');
  });
});

describe('NURTURE_MESSAGES (nurture follow-up variety)', () => {
  it('still has exactly 3 steps, preserving the existing eligibility/schedule contract', () => {
    expect(NURTURE_MESSAGES).toHaveLength(3);
  });

  it('each step offers more than one wording variant', () => {
    for (const stepVariants of NURTURE_MESSAGES) {
      expect(stepVariants.length).toBeGreaterThan(1);
    }
  });

  it('every variant still includes the required opt-out language and the subject placeholder', () => {
    for (const stepVariants of NURTURE_MESSAGES) {
      for (const build of stepVariants) {
        const text = build('Action Auto', 'Jordan', 'the 2022 Civic');
        expect(text).toContain('Reply STOP to opt out');
        expect(text).toContain('the 2022 Civic');
        expect(text).toContain('Jordan');
      }
    }
  });

  it('different leads at the same step can receive different wording (real variety, not just different steps)', () => {
    const stepVariants = NURTURE_MESSAGES[0];
    const texts = new Set(
      Array.from({ length: 20 }, (_, i) => pickVariant(stepVariants, `lead-${i}`)('Action Auto', 'Jordan', 'the 2022 Civic')),
    );
    expect(texts.size).toBeGreaterThan(1);
  });
});

describe('buildReviewRequestMessage (review-request variety)', () => {
  it('includes the review link and opt-out language when a link is configured', () => {
    const text = buildReviewRequestMessage('Action Auto', 'Jordan', 'https://g.page/r/review', 'appt-1');
    expect(text).toContain('https://g.page/r/review');
    expect(text).toContain('Reply STOP to opt out');
  });

  it('omits any link reference and still includes opt-out language when no link is configured', () => {
    const text = buildReviewRequestMessage('Action Auto', 'Jordan', null, 'appt-1');
    expect(text).not.toContain('http');
    expect(text).toContain('Reply STOP to opt out');
  });

  it('is deterministic per appointment id', () => {
    const first = buildReviewRequestMessage('Action Auto', 'Jordan', 'https://g.page/r/review', 'appt-42');
    const second = buildReviewRequestMessage('Action Auto', 'Jordan', 'https://g.page/r/review', 'appt-42');
    expect(first).toBe(second);
  });

  it('different appointments can receive different wording in both the linked and unlinked cases', () => {
    const linkedTexts = new Set(
      Array.from({ length: 20 }, (_, i) => buildReviewRequestMessage('Action Auto', 'Jordan', 'https://g.page/r/review', `appt-${i}`)),
    );
    const unlinkedTexts = new Set(
      Array.from({ length: 20 }, (_, i) => buildReviewRequestMessage('Action Auto', 'Jordan', null, `appt-${i}`)),
    );
    expect(linkedTexts.size).toBeGreaterThan(1);
    expect(unlinkedTexts.size).toBeGreaterThan(1);
  });
});
