/**
 * Who may accept a staff invitation (2026-11-11): only the account it was
 * sent to, and never a driver account.
 */
import { INVITATION_MESSAGES, invitationAcceptanceProblem } from '../../src/utils/invitationAcceptance';

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
    expect(problem?.message).toContain("driver accounts can't also be dealership staff");
  });

  it('the invitation messages say what to do next', () => {
    for (const message of Object.values(INVITATION_MESSAGES)) {
      expect(message).toMatch(/ask the person who invited you|sign in/i);
    }
  });
});
