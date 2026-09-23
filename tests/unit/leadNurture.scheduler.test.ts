const mockLeadFind = jest.fn();
const mockLeadFindOneAndUpdate = jest.fn();
const mockLeadUpdateOne = jest.fn();
const mockAppointmentExists = jest.fn();
const mockCommunicationFindOne = jest.fn();
const mockCallFindOne = jest.fn();
const mockIsSmsOptedOut = jest.fn();
const mockSendLeadNurtureText = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: {
    find: mockLeadFind,
    findOneAndUpdate: mockLeadFindOneAndUpdate,
    updateOne: mockLeadUpdateOne,
  },
}));

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { exists: mockAppointmentExists },
}));

jest.mock('../../src/models/communication.model', () => ({
  CommunicationMessage: { findOne: mockCommunicationFindOne },
  CallLog: { findOne: mockCallFindOne },
}));

jest.mock('../../src/services/communication.service', () => ({
  isSmsOptedOut: mockIsSmsOptedOut,
  sendLeadNurtureText: mockSendLeadNurtureText,
}));

jest.mock('../../src/controllers/lead.controller', () => ({
  getCentralOAuth2Client: jest.fn(),
}));

jest.mock('../../src/utils/sendingWindow', () => ({
  isWithinSendingHours: jest.fn(() => true),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

import { runLeadNurtureSweep } from '../../src/schedulers/leadNurture.scheduler';

function oldLead() {
  return {
    _id: 'lead-1',
    organizationId: 'org-1',
    firstName: 'Alex',
    phone: '+13035550123',
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    followUp: { nurtureCount: 0 },
  };
}

function emptyLookup() {
  return {
    sort: jest.fn(() => ({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) })),
  };
}

function seedCandidates(items = [oldLead()]) {
  const lean = jest.fn().mockResolvedValue(items);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  const select = jest.fn(() => ({ sort }));
  mockLeadFind.mockReturnValue({ select });
}

describe('lead nurture scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedCandidates();
    mockCommunicationFindOne.mockImplementation(emptyLookup);
    mockCallFindOne.mockImplementation(emptyLookup);
    mockAppointmentExists.mockResolvedValue(null);
    mockIsSmsOptedOut.mockResolvedValue(false);
    mockLeadFindOneAndUpdate.mockResolvedValue(oldLead());
    mockLeadUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('advances the nurture sequence only after a successful send', async () => {
    mockSendLeadNurtureText.mockResolvedValue(true);

    const stats = await runLeadNurtureSweep();

    expect(stats).toEqual({ scanned: 1, sent: 1, skipped: 0, errors: 0 });
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', 'followUp.nurtureStatus': 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'sent',
          'followUp.nurtureAttemptCount': 0,
        }),
        $inc: { 'followUp.nurtureCount': 1 },
      }),
      { timestamps: false },
    );
  });

  it('keeps the current nurture step when the provider fails', async () => {
    mockSendLeadNurtureText.mockRejectedValue(new Error('provider unavailable'));

    const stats = await runLeadNurtureSweep();

    expect(stats.errors).toBe(1);
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', 'followUp.nurtureStatus': 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'failed',
          'followUp.nurtureFailureReason': 'provider unavailable',
          'followUp.nurtureNextRetryAt': expect.any(Date),
        }),
      }),
      { timestamps: false },
    );
  });

  it('does not claim or send an opted-out lead', async () => {
    mockIsSmsOptedOut.mockResolvedValue(true);

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', status: { $in: ['New', 'Contacted', 'Pending'] } },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'skipped',
          'followUp.nurtureFailureReason': 'Customer opted out of SMS',
        }),
      }),
      { timestamps: false },
    );
  });

  it('does not claim or send when the lead has an upcoming appointment', async () => {
    mockAppointmentExists.mockResolvedValue({ _id: 'appointment-2' });

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
  });
});
