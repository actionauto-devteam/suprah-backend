/**
 * Staff account deletion requests (2026-11-12): staff ask, an admin of their
 * dealership approves (the same steps as Remove member, then the account is
 * erased) or rejects with a reason they see. Models are stand-ins; no
 * database is used.
 */
const mockRequestFindOne = jest.fn();
const mockRequestFindById = jest.fn();
const mockRequestCreate = jest.fn();
const mockRequestFindOneAndUpdate = jest.fn();
const mockRequestUpdateOne = jest.fn();
const mockUserFindById = jest.fn();
const mockOrgFindById = jest.fn();
const mockCrmUpdateMany = jest.fn();
const mockSendEmail = jest.fn();
const mockRemoveMember = jest.fn();
const mockErase = jest.fn();
const mockNotifyAdmins = jest.fn();
const mockNotify = jest.fn();
const mockRevokeTray = jest.fn();

jest.mock('../../src/models/AccountDeletionRequest.model', () => ({
  __esModule: true,
  default: {
    findOne: mockRequestFindOne,
    findById: mockRequestFindById,
    create: mockRequestCreate,
    findOneAndUpdate: mockRequestFindOneAndUpdate,
    updateOne: mockRequestUpdateOne,
  },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { updateMany: mockCrmUpdateMany } }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: { sendEmail: mockSendEmail } }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/services/memberRemoval.service', () => ({ removeMemberFromOrganization: mockRemoveMember }));
jest.mock('../../src/services/accountDeletion.service', () => ({
  eraseAccount: mockErase,
  RETENTION_ACKNOWLEDGEMENT_REQUIRED: 'Before your account can be deleted, confirm...',
}));
jest.mock('../../src/services/trayDevice.service', () => ({ revokeTrayDevicesForEmail: mockRevokeTray }));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: mockNotifyAdmins, safeCreateNotification: mockNotify }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  approveStaffDeletion,
  cleanNote,
  cleanRejectionReason,
  rejectStaffDeletion,
  requestStaffDeletion,
  STAFF_DELETION_MESSAGES,
  staffDeletionRequestProblem,
  staffDeletionReviewProblem,
} from '../../src/services/staffDeletionRequest.service';
import { staffDeletionApprovedEmail, staffDeletionRejectedEmail } from '../../src/utils/staffDeletionEmails';

const ORG = '64b0000000000000000000aa';
const STAFF = '64b0000000000000000000b1';
const ADMIN = '64b0000000000000000000c1';
const OWNER = '64b0000000000000000000d1';
const REQUEST = '64b0000000000000000000e1';

const lean = (value: unknown) => ({ select: () => ({ lean: async () => value }), lean: async () => value, sort: () => ({ lean: async () => value }) });
const pending = { _id: REQUEST, userId: STAFF, organizationId: ORG, status: 'pending' };
const admin = { _id: ADMIN, role: 'employee', orgId: ORG, orgRole: 'admin', name: 'Ana Admin' };

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgFindById.mockReturnValue(lean({ _id: ORG, ownerId: OWNER, name: 'Action Auto Utah' }));
  mockRemoveMember.mockResolvedValue({ transferredLoads: [], deletedLoads: [] });
  mockErase.mockResolvedValue(undefined);
  mockCrmUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  mockRevokeTray.mockResolvedValue(0);
  mockSendEmail.mockResolvedValue(undefined);
  mockRequestUpdateOne.mockResolvedValue({});
});

describe('who can send a request', () => {
  const org = { ownerId: OWNER, name: 'Action Auto Utah' };

  it('staff (members and admins) of a dealership', () => {
    for (const role of ['employee', 'admin']) {
      expect(staffDeletionRequestProblem({ userId: STAFF, role, organizationId: ORG, organization: org })).toBeNull();
    }
  });

  it('not drivers, customers or the Suprah AI team, who have their own way', () => {
    expect(staffDeletionRequestProblem({ userId: STAFF, role: 'driver', organizationId: ORG, organization: org })?.message).toBe(STAFF_DELETION_MESSAGES.notStaff);
    expect(staffDeletionRequestProblem({ userId: STAFF, role: 'customer', organizationId: ORG, organization: org })?.status).toBe(403);
    expect(staffDeletionRequestProblem({ userId: STAFF, role: 'super_admin', organizationId: ORG, organization: org })?.message).toBe(STAFF_DELETION_MESSAGES.suprahTeam);
  });

  it('staff without a dealership, or its owner, are told to email support', () => {
    expect(staffDeletionRequestProblem({ userId: STAFF, role: 'employee', organizationId: null, organization: null })?.message).toContain('support@suprahai.com');
    expect(staffDeletionRequestProblem({ userId: OWNER, role: 'admin', organizationId: ORG, organization: org })?.message).toBe(
      "You own Action Auto Utah, so your account can't be deleted while you're the owner. Email Suprah AI support at support@suprahai.com to hand the dealership to someone else first.",
    );
  });
});

describe('who can approve or reject', () => {
  const base = { requestUserId: STAFF, requestOrgId: ORG };

  it('an admin of the same dealership, or the Suprah AI team', () => {
    expect(staffDeletionReviewProblem({ ...base, reviewerId: ADMIN, reviewerRole: 'employee', reviewerOrgId: ORG, reviewerOrgRole: 'admin' })).toBeNull();
    expect(staffDeletionReviewProblem({ ...base, reviewerId: ADMIN, reviewerRole: 'super_admin', reviewerOrgId: null, reviewerOrgRole: null })).toBeNull();
  });

  it('not a member, an admin of another dealership, or the person who asked', () => {
    expect(staffDeletionReviewProblem({ ...base, reviewerId: ADMIN, reviewerRole: 'employee', reviewerOrgId: ORG, reviewerOrgRole: 'member' })?.message).toBe(STAFF_DELETION_MESSAGES.notReviewer);
    expect(staffDeletionReviewProblem({ ...base, reviewerId: ADMIN, reviewerRole: 'admin', reviewerOrgId: 'other-dealership', reviewerOrgRole: 'admin' })?.status).toBe(403);
    expect(staffDeletionReviewProblem({ ...base, reviewerId: STAFF, reviewerRole: 'admin', reviewerOrgId: ORG, reviewerOrgRole: 'admin' })?.message).toBe(STAFF_DELETION_MESSAGES.ownRequest);
  });

  it('a rejection needs a reason of 5 to 500 characters; the note is optional', () => {
    expect(cleanRejectionReason('  Finish handing over your leads first.  ')).toBe('Finish handing over your leads first.');
    for (const reason of [undefined, '', 'no', 'x'.repeat(501), 42]) expect(cleanRejectionReason(reason)).toBeNull();
    expect(cleanNote('  Leaving the company  ')).toBe('Leaving the company');
    expect(cleanNote('   ')).toBeUndefined();
    expect(cleanNote('x'.repeat(600))).toHaveLength(500);
  });
});

describe('sending a request', () => {
  const staff = { _id: STAFF, role: 'employee', organizationId: ORG, name: 'Sam Staff' };

  it('needs the acknowledgement of what Suprah AI keeps', async () => {
    await expect(requestStaffDeletion(staff, { acknowledgedRetention: false })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockRequestCreate).not.toHaveBeenCalled();
  });

  it("opens the request and tells the dealership's admins, not the person asking", async () => {
    mockRequestFindOne.mockReturnValue(lean(null));
    mockRequestCreate.mockResolvedValue({ _id: REQUEST, createdAt: new Date('2026-11-12T10:00:00Z') });
    const result = await requestStaffDeletion(staff, { acknowledgedRetention: true, note: ' Leaving the company ' });

    expect(result).toMatchObject({ id: REQUEST, status: 'pending' });
    expect(mockRequestCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: STAFF, organizationId: ORG, note: 'Leaving the company', acknowledgedRetention: true }));
    expect(mockNotifyAdmins).toHaveBeenCalledWith(
      ORG,
      'general',
      'Account deletion request',
      'Sam Staff asked to delete their account. Review it in Settings, Dealership.',
      { route: '/settings?tab=dealership', requestId: REQUEST },
      STAFF,
    );
  });

  it('sending again while one is open returns it without telling the admins twice', async () => {
    mockRequestFindOne.mockReturnValue(lean({ _id: REQUEST, status: 'pending', createdAt: new Date() }));
    await expect(requestStaffDeletion(staff, { acknowledgedRetention: true })).resolves.toMatchObject({ id: REQUEST, status: 'pending' });
    expect(mockRequestCreate).not.toHaveBeenCalled();
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
  });
});

describe('rejecting', () => {
  it('needs a reason, and the person sees it in the app and by email', async () => {
    await expect(rejectStaffDeletion(admin, REQUEST, 'no')).rejects.toMatchObject({ statusCode: 400, message: STAFF_DELETION_MESSAGES.reasonNeeded });

    mockRequestFindById.mockReturnValue(lean(pending));
    mockRequestFindOneAndUpdate.mockResolvedValue({ _id: REQUEST });
    mockUserFindById.mockReturnValue(lean({ email: 'sam@dealer.com' }));
    await rejectStaffDeletion(admin, REQUEST, 'Please hand over your open leads first.');

    expect(mockRequestFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: REQUEST, status: 'pending' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'rejected', rejectionReason: 'Please hand over your open leads first.', decidedBy: ADMIN }) }),
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: STAFF,
      title: 'Account deletion request declined',
      message: 'An admin declined your request to delete your account. Their reason: Please hand over your open leads first.',
      metadata: { route: '/profile', requestId: REQUEST },
    }));
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({ to: 'sam@dealer.com', subject: 'Your account deletion request at Action Auto Utah was declined' });
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("someone else's request, or one already decided, can't be rejected", async () => {
    mockRequestFindById.mockReturnValue(lean(pending));
    await expect(rejectStaffDeletion({ ...admin, orgId: 'other-dealership' }, REQUEST, 'Not now, sorry.')).rejects.toMatchObject({ statusCode: 403 });
    mockRequestFindById.mockReturnValue(lean({ ...pending, status: 'approved' }));
    await expect(rejectStaffDeletion(admin, REQUEST, 'Not now, sorry.')).rejects.toMatchObject({ statusCode: 409, message: STAFF_DELETION_MESSAGES.notOpen });
  });
});

describe('approving', () => {
  beforeEach(() => {
    mockRequestFindById.mockReturnValue(lean(pending));
    mockUserFindById.mockReturnValue(lean({ _id: STAFF, email: 'Sam@Dealer.com', name: 'Sam Staff', role: 'employee', organizationId: ORG }));
  });

  it('runs Remove member, emails them, turns off the CRM sign-in and erases the account', async () => {
    mockRemoveMember.mockResolvedValue({ transferredLoads: [{ loadNumber: 'LD-7' }], deletedLoads: [] });
    await expect(approveStaffDeletion(admin, REQUEST)).resolves.toEqual({ transferredLoadNumbers: ['LD-7'] });

    expect(mockRemoveMember).toHaveBeenCalledWith({ orgId: ORG, userId: STAFF, actingUserId: ADMIN });
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({ to: 'sam@dealer.com', subject: 'Your Suprah AI account was deleted' });
    expect(mockCrmUpdateMany).toHaveBeenCalledWith({ email: 'sam@dealer.com', organizationId: ORG, isActive: true }, { $set: { isActive: false } });
    expect(mockErase).toHaveBeenCalledWith(STAFF, 'staff');
    expect(mockRequestUpdateOne).toHaveBeenCalledWith({ _id: REQUEST }, expect.objectContaining({ $set: expect.objectContaining({ status: 'approved', decidedBy: ADMIN }) }));
    // The order matters: they leave the dealership before the account is erased.
    expect(mockRemoveMember.mock.invocationCallOrder[0]).toBeLessThan(mockErase.mock.invocationCallOrder[0]);
  });

  it('a load they created still in progress stops it, and nothing is erased', async () => {
    mockRemoveMember.mockRejectedValue(Object.assign(new Error("This member can't be removed yet because they created load LD-9, which is In-Transit."), { statusCode: 409 }));
    await expect(approveStaffDeletion(admin, REQUEST)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockErase).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("the dealership's owner can't be approved", async () => {
    mockRequestFindById.mockReturnValue(lean({ ...pending, userId: OWNER }));
    mockUserFindById.mockReturnValue(lean({ _id: OWNER, email: 'owner@dealer.com', role: 'admin', organizationId: ORG }));
    await expect(approveStaffDeletion(admin, REQUEST)).rejects.toMatchObject({ statusCode: 409, message: STAFF_DELETION_MESSAGES.ownerApprove });
    expect(mockRemoveMember).not.toHaveBeenCalled();
  });

  it('someone no longer on the team: the request is closed, nothing else happens', async () => {
    mockUserFindById.mockReturnValue(lean({ _id: STAFF, email: 'sam@dealer.com', role: 'employee', organizationId: 'other-dealership' }));
    await expect(approveStaffDeletion(admin, REQUEST)).rejects.toMatchObject({ statusCode: 409, message: STAFF_DELETION_MESSAGES.noLongerMember });
    expect(mockRequestUpdateOne).toHaveBeenCalledWith({ _id: REQUEST, status: 'pending' }, expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }));
    expect(mockRemoveMember).not.toHaveBeenCalled();
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("an admin can't approve their own request", async () => {
    mockRequestFindById.mockReturnValue(lean({ ...pending, userId: ADMIN }));
    await expect(approveStaffDeletion(admin, REQUEST)).rejects.toMatchObject({ statusCode: 403, message: STAFF_DELETION_MESSAGES.ownRequest });
  });
});

describe('the emails', () => {
  it("show the admin's reason and the dealership's name as text, never as links or formatting", () => {
    const email = staffDeletionRejectedEmail({ organizationName: 'Dealer <b>X</b>\nBcc: all@example.com', reason: '<a href="https://evil.example">Click</a>' });
    expect(email.subject).toBe('Your account deletion request at Dealer <b>X</b> Bcc: all@example.com was declined');
    expect(email.html).not.toContain('<a href="https://evil.example">');
    expect(email.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Click&lt;/a&gt;');
    expect(email.html).toContain('Dealer &lt;b&gt;X&lt;/b&gt;');
  });

  it('the deleted email says what Suprah AI and the dealership keep', () => {
    const email = staffDeletionApprovedEmail({ organizationName: 'Action Auto Utah' });
    expect(email.text).toContain('compliance, accounting, tax laws and fraud prevention');
    expect(email.text).toContain('your dealership keeps its own business and employee records');
  });
});
