const mockCount = jest.fn();
const mockAggregate = jest.fn();
const mockClaim = jest.fn();
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue({ successful: 1 });

jest.mock('../../src/models/AiAgentTask.model', () => ({
  __esModule: true,
  default: { countDocuments: mockCount, aggregate: mockAggregate },
}));
jest.mock('../../src/models/AiTechnicalAlertState.model', () => ({
  __esModule: true,
  default: { findOneAndUpdate: mockClaim },
}));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: mockNotifyOrgAdmins }));

import { maybeAlertTechnicalFailures, technicalAlertThreshold } from '../../src/services/aiTechnicalAlert.service';

const ORG = '507f1f77bcf86cd799439011';
const NOW = new Date('2026-10-21T15:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AI_TECHNICAL_ALERT_THRESHOLD;
  mockAggregate.mockResolvedValue([{ _id: 'timeout', n: 3 }, { _id: 'provider_error', n: 2 }]);
  mockClaim.mockResolvedValue({ _id: `ai-technical-alert:${ORG}` });
});

describe('technicalAlertThreshold', () => {
  it.each([
    [undefined, 5],
    ['3', 3],
    ['100', 100],
    ['1', 5],
    ['101', 5],
    ['2.5', 5],
    ['abc', 5],
  ])('reads %p as %p', (value, expected) => {
    if (value === undefined) delete process.env.AI_TECHNICAL_ALERT_THRESHOLD;
    else process.env.AI_TECHNICAL_ALERT_THRESHOLD = value;
    expect(technicalAlertThreshold()).toBe(expected);
  });
});

describe('maybeAlertTechnicalFailures', () => {
  it('does nothing below the threshold', async () => {
    mockCount.mockResolvedValue(4);
    expect(await maybeAlertTechnicalFailures({ organizationId: ORG, now: NOW })).toEqual({ alerted: false, count: 4, reason: 'below_threshold' });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('counts only this organization\'s technical tasks inside the last hour', async () => {
    mockCount.mockResolvedValue(0);
    await maybeAlertTechnicalFailures({ organizationId: ORG, now: NOW });
    expect(mockCount).toHaveBeenCalledWith({
      organizationId: ORG, attentionKind: 'technical', createdAt: { $gte: new Date('2026-10-21T14:00:00.000Z') },
    });
  });

  it('claims once per org per hour and sends one admin alert at the threshold', async () => {
    mockCount.mockResolvedValue(5);
    expect(await maybeAlertTechnicalFailures({ organizationId: ORG, agentName: 'Anna', now: NOW })).toEqual({ alerted: true, count: 5 });
    expect(mockClaim).toHaveBeenCalledWith(
      { _id: `ai-technical-alert:${ORG}`, $or: [{ lastAlertAt: { $lt: new Date('2026-10-21T14:00:00.000Z') } }, { lastAlertAt: null }] },
      { $set: { organizationId: ORG, lastAlertAt: NOW, lastCount: 5 } },
      { upsert: true, new: true },
    );
    expect(mockNotifyOrgAdmins).toHaveBeenCalledTimes(1);
    const [orgId, type, title, message, metadata] = mockNotifyOrgAdmins.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(type).toBe('ai_technical_failures_alert');
    expect(title).toBe("Anna's safety check failed 5 times in the last hour");
    expect(message).toContain('timed out (3), service error (2)');
    expect(metadata).toEqual({ route: '/crm/ai-tasks?kind=technical', count: 5, threshold: 5, windowMinutes: 60,
      codes: { timeout: 3, provider_error: 2 }, alertedAt: NOW.toISOString() });
  });

  it('treats a duplicate-key claim as already alerted this hour', async () => {
    mockCount.mockResolvedValue(9);
    mockClaim.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    expect(await maybeAlertTechnicalFailures({ organizationId: ORG, now: NOW })).toEqual({ alerted: false, count: 9, reason: 'recently_alerted' });
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('rethrows unexpected claim errors so the caller can log them', async () => {
    mockCount.mockResolvedValue(9);
    mockClaim.mockRejectedValue(new Error('connection lost'));
    await expect(maybeAlertTechnicalFailures({ organizationId: ORG, now: NOW })).rejects.toThrow('connection lost');
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('honors a configured threshold', async () => {
    process.env.AI_TECHNICAL_ALERT_THRESHOLD = '3';
    mockCount.mockResolvedValue(3);
    expect((await maybeAlertTechnicalFailures({ organizationId: ORG, now: NOW })).alerted).toBe(true);
  });

  it('never puts customer content in the alert, only counts and failure codes', async () => {
    mockCount.mockResolvedValue(6);
    mockAggregate.mockResolvedValue([{ _id: 'timeout', n: 6 }, { _id: 'Customer said SECRET', n: 1 }]);
    await maybeAlertTechnicalFailures({ organizationId: ORG, now: NOW });
    expect(JSON.stringify(mockNotifyOrgAdmins.mock.calls)).not.toContain('SECRET');
  });
});
