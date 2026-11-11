/**
 * Who may accept a staff invitation (2026-11-11): only the account it was
 * sent to, and never a driver account.
 */
import {
  INVITATION_MESSAGES,
  INVITE_INPUT_MESSAGES,
  adminInviteNote,
  invitationAcceptanceProblem,
  invitedAccountStatus,
  inviteEmailOrNull,
  staffInviteRoleOrNull,
  staffInviteTargetProblem,
} from '../../src/utils/invitationAcceptance';

describe('accepting a staff invitation', () => {
  it('the invited account can accept it (any letter case or spaces in the email)', () => {
    expect(invitationAcceptanceProblem({ inviteEmail: 'Maria@Dealer.com ', userEmail: 'maria@dealer.com', userRole: 'customer' })).toBeNull();
    expect(invitationAcceptanceProblem({ inviteEmail: 'maria@dealer.com', userEmail: 'maria@dealer.com', userRole: 'employee' })).toBeNull();
  });

  it('another signed-in account is told which email the invitation is for', () => {
    expect(invitationAcceptanceProblem({ inviteEmail: 'maria@dealer.com', userEmail: 'someone@else.com', userRole: 'admin' })).toEqual({
      status: 403,
      message: 'This invitation was sent to maria@dealer.com. Sign out, then sign in or create an account with that email to accept it.',
    });
    expect(invitationAcceptanceProblem({ inviteEmail: '', userEmail: '', userRole: 'customer' })?.status).toBe(403);
  });

  it("a driver account can't become dealership staff", () => {
    const problem = invitationAcceptanceProblem({ inviteEmail: 'sam@driver.com', userEmail: 'sam@driver.com', userRole: 'driver' });
    expect(problem?.status).toBe(409);
    expect(problem?.message).toContain("is registered as a driver account, so it can't be used for a staff account");
  });

  it('the invitation messages say what to do next', () => {
    for (const message of Object.values(INVITATION_MESSAGES)) {
      expect(message).toMatch(/ask the person who invited you|sign in/i);
    }
  });
});

describe('sending a staff invitation', () => {
  const ORG = '64b0000000000000000000aa';

  it("a new email or a customer (even this dealership's own) can be invited", () => {
    expect(staffInviteTargetProblem({ existing: null, organizationId: ORG })).toBeNull();
    expect(staffInviteTargetProblem({ existing: { role: 'customer', organizationId: ORG }, organizationId: ORG })).toBeNull();
    expect(staffInviteTargetProblem({ existing: { role: 'employee', organizationId: 'another-dealership' }, organizationId: ORG })).toBeNull();
  });

  it('a driver account gets a plain reason instead of "already a member"', () => {
    for (const organizationId of [ORG, undefined]) {
      expect(staffInviteTargetProblem({ existing: { role: 'driver', organizationId }, organizationId: ORG })).toEqual({
        kind: 'driver',
        status: 409,
        message: "This email is registered as a driver account, so it can't be used for a staff account. Ask them for a different email for their staff account.",
      });
    }
  });

  it('someone already on this team is told so', () => {
    for (const role of ['employee', 'admin']) {
      expect(staffInviteTargetProblem({ existing: { role, organizationId: ORG }, organizationId: ORG })).toMatchObject({ kind: 'team', message: 'This person is already on your team.' });
    }
  });
});

describe("what kind of account the invited email already has", () => {
  const ORG = "64b0000000000000000000aa";
  it("so the invitation can say what accepting will do", () => {
    expect(invitedAccountStatus(null, ORG)).toBe("none");
    expect(invitedAccountStatus({ role: "customer", organizationId: ORG }, ORG)).toBe("customer");
    expect(invitedAccountStatus({ role: "driver", organizationId: ORG }, ORG)).toBe("driver");
    expect(invitedAccountStatus({ role: "employee", organizationId: ORG }, ORG)).toBe("team");
    expect(invitedAccountStatus({ role: "admin", organizationId: "another-dealership" }, ORG)).toBe("other-dealership-staff");
  });
});

describe('what an admin may send (2026-11-11)', () => {
  it('a real email address, saved in lowercase without spaces', () => {
    expect(inviteEmailOrNull(' Maria.Lopez@Dealer.com ')).toBe('maria.lopez@dealer.com');
    expect(inviteEmailOrNull('sam+sales@dealer.co.uk')).toBe('sam+sales@dealer.co.uk');
  });

  it('anything that is not an email address is refused', () => {
    for (const value of ['', 'maria', 'maria@dealer', '@dealer.com', 'maria@@dealer.com', 'maria lopez@dealer.com', '<b>x</b>@dealer.com', 'a@b.com, c@d.com', `${'a'.repeat(250)}@x.com`, null, undefined, 42, ['a@b.com'], { $ne: null }]) {
      expect(inviteEmailOrNull(value)).toBeNull();
    }
  });

  it('Member when no role is sent, Member or Admin when chosen, nothing else', () => {
    expect(staffInviteRoleOrNull(undefined)).toBe('member');
    expect(staffInviteRoleOrNull('')).toBe('member');
    expect(staffInviteRoleOrNull('member')).toBe('member');
    expect(staffInviteRoleOrNull('admin')).toBe('admin');
    for (const value of ['customer', 'driver', 'super_admin', 'employee', 'Admin', ['admin'], { role: 'admin' }]) {
      expect(staffInviteRoleOrNull(value)).toBeNull();
    }
  });

  it('the messages say what to fix', () => {
    expect(INVITE_INPUT_MESSAGES.email).toBe('Enter a valid email address, like name@example.com.');
    expect(INVITE_INPUT_MESSAGES.role).toBe('Choose Member or Admin for the invitation.');
  });
});

describe("what the admin hears after sending (2026-11-11)", () => {
  const ORG = "64b0000000000000000000aa";

  it("only that the email is one of the dealership's own customers", () => {
    expect(adminInviteNote({ role: "customer", organizationId: ORG }, ORG)).toBe("customer");
  });

  it("nothing about accounts anywhere else, or a new email", () => {
    expect(adminInviteNote(null, ORG)).toBeNull();
    expect(adminInviteNote({ role: "customer", organizationId: "another-dealership" }, ORG)).toBeNull();
    expect(adminInviteNote({ role: "customer" }, ORG)).toBeNull();
    expect(adminInviteNote({ role: "employee", organizationId: "another-dealership" }, ORG)).toBeNull();
    expect(adminInviteNote({ role: "admin", organizationId: "another-dealership" }, ORG)).toBeNull();
  });
});
