/**
 * Who may accept a staff invitation (2026-11-11): only the account it was
 * sent to, and never a driver account.
 */
import { INVITATION_MESSAGES, invitationAcceptanceProblem, invitedAccountStatus, staffInviteTargetProblem } from '../../src/utils/invitationAcceptance';

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
