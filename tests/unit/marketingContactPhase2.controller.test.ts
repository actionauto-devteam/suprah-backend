const mockMcFindOne = jest.fn();
const mockMcCreate = jest.fn();
const mockMcFind = jest.fn();
const mockMcCountDocuments = jest.fn();
const mockMcUpdateOne = jest.fn();
const mockOptOutFindOne = jest.fn();
const mockOptOutFind = jest.fn();

jest.mock('../../src/models/MarketingContact.model', () => ({
  __esModule: true,
  default: {
    findOne: mockMcFindOne,
    create: mockMcCreate,
    find: mockMcFind,
    countDocuments: mockMcCountDocuments,
    updateOne: mockMcUpdateOne,
  },
}));
jest.mock('../../src/models/EmailOptOut.model', () => ({
  __esModule: true,
  default: { findOne: mockOptOutFindOne, find: mockOptOutFind },
}));

import { createManualMarketingContact, getEligibleMarketingContactIds, getMarketingContactEligibleCount } from '../../src/controllers/marketingContact.controller';

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  fn(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next };
}

function adminReq(body: Record<string, any> = {}, query: Record<string, any> = {}) {
  return {
    orgId: 'org-1',
    crmUser: { _id: 'user-1', role: 'admin' },
    body,
    query,
  };
}

describe('marketingContact.controller — manual entry (Phase 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutFindOne.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) });
    mockOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
  });

  it('rejects an invalid email address without touching the database', async () => {
    const req = adminReq({ email: 'not-an-email' });

    const { next } = await invoke(createManualMarketingContact, req);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockMcFindOne).not.toHaveBeenCalled();
    expect(mockMcCreate).not.toHaveBeenCalled();
  });

  it('creates a new contact with consentStatus "unknown" — never auto-marks a manually entered address as consented', async () => {
    mockMcFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const created = {
      toObject: () => ({ _id: 'mc-1', email: 'new@example.com', consentStatus: 'unknown', source: 'Manual Entry', importLabel: 'Manual Entry' }),
    };
    mockMcCreate.mockResolvedValue(created);

    const req = adminReq({ email: 'New@Example.com', firstName: 'Jordan' });
    const { json, status } = await invoke(createManualMarketingContact, req);

    expect(mockMcCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        email: 'new@example.com',
        consentStatus: 'unknown',
        source: 'Manual Entry',
        importLabel: 'Manual Entry',
      }),
    );
    expect(status).toHaveBeenCalledWith(201);
    const payload = json.mock.calls[0][0];
    expect(payload.data.created).toBe(true);
    expect(payload.data.isEligible).toBe(false);
    expect(payload.data.reason).toContain('Consent is not documented');
  });

  it('reuses an existing contact untouched when the email already exists (does not recreate or alter its consent status)', async () => {
    mockMcFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'mc-2', email: 'existing@example.com', consentStatus: 'documented' }),
    });

    const req = adminReq({ email: 'existing@example.com' });
    const { json, status } = await invoke(createManualMarketingContact, req);

    expect(mockMcCreate).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0];
    expect(payload.data.created).toBe(false);
    expect(payload.data.contact.consentStatus).toBe('documented');
    expect(payload.data.isEligible).toBe(true);
    expect(payload.data.reason).toBeUndefined();
  });

  it('marks an existing-but-suppressed contact as ineligible with the opt-out reason, even if consent is documented', async () => {
    mockMcFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'mc-3', email: 'suppressed@example.com', consentStatus: 'documented' }),
    });
    mockOptOutFindOne.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ _id: 'opt-1' }) })) });

    const req = adminReq({ email: 'suppressed@example.com' });
    const { json } = await invoke(createManualMarketingContact, req);

    const payload = json.mock.calls[0][0];
    expect(payload.data.isEligible).toBe(false);
    expect(payload.data.reason).toContain('opted out');
  });

  it('rejects a non-admin user without querying the database', async () => {
    const req = { orgId: 'org-1', crmUser: { _id: 'u1', role: 'employee' }, body: { email: 'a@example.com' } };

    const { next } = await invoke(createManualMarketingContact, req);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(mockMcFindOne).not.toHaveBeenCalled();
  });
});

describe('marketingContact.controller — select-all eligible ids (Phase 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
  });

  it('returns all matching contacts uncapped when the total is within the 500 limit', async () => {
    const contacts = [{ _id: 'c1', email: 'a@example.com' }, { _id: 'c2', email: 'b@example.com' }];
    mockMcFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(contacts) })) })) });
    mockMcCountDocuments.mockResolvedValue(2);

    const req = adminReq({}, { search: 'a' });
    const { json } = await invoke(getEligibleMarketingContactIds, req);

    const payload = json.mock.calls[0][0];
    expect(payload.data.contacts).toEqual(contacts);
    expect(payload.data.total).toBe(2);
    expect(payload.data.capped).toBe(false);
  });

  it('flags capped:true and still returns the real total when eligible contacts exceed 500, rather than silently hiding the overflow', async () => {
    mockMcFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(new Array(500).fill({ _id: 'x', email: 'x@example.com' })) })) })) });
    mockMcCountDocuments.mockResolvedValue(734);

    const req = adminReq();
    const { json } = await invoke(getEligibleMarketingContactIds, req);

    const payload = json.mock.calls[0][0];
    expect(payload.data.total).toBe(734);
    expect(payload.data.capped).toBe(true);
    expect(payload.data.contacts).toHaveLength(500);
  });

  it('always applies eligibleOnly filtering (documented consent OR a confirmed permission override, plus suppression) regardless of query params', async () => {
    mockMcFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) })) });
    mockMcCountDocuments.mockResolvedValue(0);
    mockOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue(['suppressed@example.com']) });

    const req = adminReq();
    await invoke(getEligibleMarketingContactIds, req);

    const findQuery = mockMcFind.mock.calls[0][0];
    expect(findQuery.$or).toEqual([
      { consentStatus: { $in: ['documented'] } },
      { 'permissionOverride.confirmedAt': { $exists: true } },
    ]);
    expect(findQuery.email).toEqual({ $nin: ['suppressed@example.com'] });
  });

  it('composes the eligibility $or together with a search $or via $and, instead of one clobbering the other', async () => {
    mockMcFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) })) });
    mockMcCountDocuments.mockResolvedValue(0);

    const req = adminReq({}, { search: 'jordan' });
    await invoke(getEligibleMarketingContactIds, req);

    const findQuery = mockMcFind.mock.calls[0][0];
    expect(findQuery.$or).toBeUndefined();
    expect(findQuery.$and).toHaveLength(2);
    expect(findQuery.$and[0].$or).toEqual([
      { email: expect.any(RegExp) },
      { firstName: expect.any(RegExp) },
      { lastName: expect.any(RegExp) },
    ]);
    expect(findQuery.$and[1].$or).toEqual([
      { consentStatus: { $in: ['documented'] } },
      { 'permissionOverride.confirmedAt': { $exists: true } },
    ]);
  });
});

describe('marketingContact.controller — admin permission override (new)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutFindOne.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) });
  });

  it('does NOT set an override when confirmedPermission is omitted — existing "ineligible" behavior is unchanged', async () => {
    mockMcFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockMcCreate.mockResolvedValue({
      toObject: () => ({ _id: 'mc-10', email: 'new@example.com', consentStatus: 'unknown' }),
    });

    const req = adminReq({ email: 'new@example.com' });
    const { json } = await invoke(createManualMarketingContact, req);

    const payload = json.mock.calls[0][0];
    expect(payload.data.isEligible).toBe(false);
    expect(payload.data.contact.permissionOverride).toBeUndefined();
  });

  it('sets a permissionOverride (with the confirming admin and timestamp) and flips isEligible to true when confirmedPermission is true on an unknown-consent contact', async () => {
    mockMcFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockMcCreate.mockResolvedValue({
      toObject: () => ({ _id: 'mc-11', email: 'new2@example.com', consentStatus: 'unknown' }),
    });
    mockMcUpdateOne.mockResolvedValue({});

    const req = adminReq({ email: 'new2@example.com', confirmedPermission: true });
    (req as any).crmUser.fullName = 'Alex Rivera';
    const { json } = await invoke(createManualMarketingContact, req);

    expect(mockMcUpdateOne).toHaveBeenCalledWith(
      { _id: 'mc-11' },
      {
        $set: {
          permissionOverride: expect.objectContaining({
            confirmedBy: 'user-1',
            confirmedByName: 'Alex Rivera',
            confirmedAt: expect.any(Date),
          }),
        },
      },
    );
    const payload = json.mock.calls[0][0];
    expect(payload.data.isEligible).toBe(true);
    expect(payload.data.reason).toBeUndefined();
    expect(payload.data.contact.permissionOverride.confirmedByName).toBe('Alex Rivera');
  });

  it('never bypasses an explicit email opt-out, even with confirmedPermission true — suppression always wins', async () => {
    mockMcFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'mc-12', email: 'stopped@example.com', consentStatus: 'unknown' }),
    });
    mockOptOutFindOne.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ _id: 'opt-9' }) })) });
    mockMcUpdateOne.mockResolvedValue({});

    const req = adminReq({ email: 'stopped@example.com', confirmedPermission: true });
    const { json } = await invoke(createManualMarketingContact, req);

    const payload = json.mock.calls[0][0];
    expect(payload.data.isEligible).toBe(false);
    expect(payload.data.reason).toContain('opted out');
  });

  it('does not overwrite an existing permissionOverride on a repeat Add (idempotent, preserves the original confirmation)', async () => {
    const existingOverride = { confirmedBy: 'user-99', confirmedByName: 'Original Admin', confirmedAt: new Date('2026-01-01') };
    mockMcFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'mc-13', email: 'already@example.com', consentStatus: 'unknown', permissionOverride: existingOverride }),
    });

    const req = adminReq({ email: 'already@example.com', confirmedPermission: true });
    const { json } = await invoke(createManualMarketingContact, req);

    expect(mockMcUpdateOne).not.toHaveBeenCalled();
    const payload = json.mock.calls[0][0];
    expect(payload.data.contact.permissionOverride).toEqual(existingOverride);
    expect(payload.data.isEligible).toBe(true);
  });
});

describe('marketingContact.controller — getMarketingContactEligibleCount (Phase 4A large-audience preparation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
  });

  it('returns the true, uncapped count even when it is far larger than the 500 selection limit', async () => {
    mockMcCountDocuments.mockResolvedValue(18204);

    const req = adminReq({}, { importLabel: 'Big List' });
    const { json } = await invoke(getMarketingContactEligibleCount, req);

    const payload = json.mock.calls[0][0];
    expect(payload.data.count).toBe(18204);
  });

  it('never fetches or returns individual contact records — count only', async () => {
    mockMcCountDocuments.mockResolvedValue(42);

    const req = adminReq();
    await invoke(getMarketingContactEligibleCount, req);

    expect(mockMcFind).not.toHaveBeenCalled();
  });

  it('applies the same eligibility (consent OR override) + suppression filter as every other eligible-only query', async () => {
    mockMcCountDocuments.mockResolvedValue(0);
    mockOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue(['suppressed@example.com']) });

    const req = adminReq();
    await invoke(getMarketingContactEligibleCount, req);

    const countQuery = mockMcCountDocuments.mock.calls[0][0];
    expect(countQuery.$or).toEqual([
      { consentStatus: { $in: ['documented'] } },
      { 'permissionOverride.confirmedAt': { $exists: true } },
    ]);
    expect(countQuery.email).toEqual({ $nin: ['suppressed@example.com'] });
  });

  it('rejects a non-admin user without querying the database', async () => {
    const req = { orgId: 'org-1', crmUser: { _id: 'u1', role: 'employee' }, query: {} };

    const { next } = await invoke(getMarketingContactEligibleCount, req);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(mockMcCountDocuments).not.toHaveBeenCalled();
  });
});
