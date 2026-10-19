const mockLogFindOne = jest.fn();
const mockSendStaffAttributedSms = jest.fn();
const mockDecideAiDelivery = jest.fn();
const mockLeadUpdateOne = jest.fn().mockResolvedValue({});

jest.mock('../../src/models/VehicleReengagementLog.model', () => ({
  __esModule: true,
  default: { findOne: mockLogFindOne },
}));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { updateOne: mockLeadUpdateOne } }));
jest.mock('../../src/services/communication.service', () => ({ sendStaffAttributedSms: mockSendStaffAttributedSms }));
jest.mock('../../src/services/aiOperatingMode.service', () => ({ decideAiDelivery: mockDecideAiDelivery }));

import { sendAnyway } from '../../src/controllers/vehicleReengagement.controller';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';

async function invoke(req: any) {
  const json = jest.fn();
  const next = jest.fn();
  sendAnyway(req, { json, status: jest.fn(() => ({ json })) } as any, next);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  return { json, next };
}

function blockedLog() {
  const log: any = {
    _id: 'log-1',
    status: 'blocked',
    finalMessage: 'A 2022 Civic just arrived. Reply STOP to opt out.',
    leadPhone: '+13855550199',
    leadId: 'lead-1',
    save: jest.fn().mockResolvedValue(undefined),
    toObject() {
      return { _id: this._id, status: this.status };
    },
  };
  mockLogFindOne.mockResolvedValue(log);
  return log;
}

const req = { params: { id: 'log-1' }, orgId: 'org-1', crmUser: { _id: 'admin-1', role: 'admin', fullName: 'Jen' } };

describe('re-engagement Send anyway respects the SMS operating mode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is blocked with a clear message whenever text-message AI is not live', async () => {
    const log = blockedLog();
    mockDecideAiDelivery.mockResolvedValue({ action: 'skip', mode: 'training', source: 'configured' });
    const { next } = await invoke(req);
    expect(next.mock.calls[0][0].statusCode).toBe(409);
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
    expect(log.save).not.toHaveBeenCalled();
    expect(mockDecideAiDelivery).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'reengagement_send_anyway', channel: 'sms' }));
  });

  it('is blocked if the mode changes between the check and the provider call', async () => {
    const log = blockedLog();
    mockDecideAiDelivery.mockResolvedValue({ action: 'send', mode: 'live', source: 'configured' });
    mockSendStaffAttributedSms.mockRejectedValue(new AiReplySuppressedError());
    const { next } = await invoke(req);
    expect(next.mock.calls[0][0].statusCode).toBe(409);
    expect(log.save).not.toHaveBeenCalled();
    expect(log.status).toBe('blocked');
  });

  it('still works when live, through the guarded path', async () => {
    const log = blockedLog();
    mockDecideAiDelivery.mockResolvedValue({ action: 'send', mode: 'live', source: 'configured' });
    mockSendStaffAttributedSms.mockResolvedValue({ message: { _id: 'm1' } });
    const { json } = await invoke(req);
    expect(mockSendStaffAttributedSms).toHaveBeenCalledWith(expect.objectContaining({ aiWorkflow: 'reengagement_send_anyway' }));
    expect(log.status).toBe('sent');
    expect(json).toHaveBeenCalled();
  });
});
