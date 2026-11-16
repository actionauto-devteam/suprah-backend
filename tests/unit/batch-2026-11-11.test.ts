// Tests from the November 11, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from signupCodeEmail.test.ts
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Session.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/services/token.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/driverApplication.service', () => ({ findOrCreatePendingDriverRequest: jest.fn() }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: { sendEmail: mockSendEmail } }));

// Used by the fakes from signupCodeEmail.test.ts (above the imports, as in that file)
const mockSendEmail = jest.fn();
const mockOrgFindById = jest.fn();

import { INVITATION_MESSAGES, INVITE_INPUT_MESSAGES, adminInviteNote, invitationAcceptanceProblem, invitedAccountStatus, inviteEmailOrNull, staffInviteRoleOrNull, staffInviteTargetProblem } from '../../src/utils/invitationAcceptance';
import { staffInviteEmail } from '../../src/utils/staffInviteEmail';
import authService from '../../src/services/auth.service';

describe('invitationAcceptance.test.ts', () => {
  /**
   * Who may accept a staff invitation (2026-11-11): only the account it was
   * sent to, and never a driver account.
   */
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
});

describe('staffInviteEmail.test.ts', () => {
  /**
   * The staff invitation email (2026-11-11): names typed by people can't add
   * links, buttons or email headers, and the email still says who invited them,
   * to which dealership, with the link.
   */
  const LINK = 'https://app.example.com/accept-invite?token=abc123';

  describe('staff invitation email', () => {
    it('says who invited them, to which dealership, with the link', () => {
      const email = staffInviteEmail({ inviterName: 'Maria Lopez', organizationName: 'Action Auto Utah', inviteLink: LINK });
      expect(email.subject).toBe("You've been invited to join Action Auto Utah on Suprah.AI");
      expect(email.text).toContain('Maria Lopez has invited you to join the organization Action Auto Utah on Suprah.AI.');
      expect(email.text).toContain(`Accept here: ${LINK}`);
      expect(email.html).toContain('<strong>Maria Lopez</strong>');
      expect(email.html).toContain('<strong>Action Auto Utah</strong>');
      expect(email.html).toContain(`href="${LINK}"`);
      expect(email.html).toContain('If you did not expect this invitation, you can ignore this email.');
    });

    it("a name can't add a link or formatting to the email", () => {
      const email = staffInviteEmail({
        inviterName: '<a href="https://evil.example">Reset your password</a>',
        organizationName: 'Dealer <img src=x onerror=alert(1)> & "Sons"',
        inviteLink: LINK,
      });
      expect(email.html).not.toContain('<a href="https://evil.example">');
      expect(email.html).not.toContain('<img');
      expect(email.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Reset your password&lt;/a&gt;');
      expect(email.html).toContain('Dealer &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Sons&quot;');
      // Only the one real button link.
      expect(email.html.match(/<a /g)).toHaveLength(1);
    });

    it("a name can't add a line (or an email header) to the subject", () => {
      const email = staffInviteEmail({ inviterName: 'Maria', organizationName: 'Dealer\r\nBcc: everyone@example.com', inviteLink: LINK });
      expect(email.subject).not.toMatch(/[\r\n]/);
      expect(email.subject).toBe("You've been invited to join Dealer Bcc: everyone@example.com on Suprah.AI");
    });

    it('falls back to plain words when a name is missing', () => {
      const email = staffInviteEmail({ inviterName: '  ', organizationName: null, inviteLink: LINK });
      expect(email.subject).toBe("You've been invited to join a dealership on Suprah.AI");
      expect(email.text).toContain('Someone has invited you');
    });
  });
});

describe('signupCodeEmail.test.ts', () => {
  /**
   * The first 6-digit code for an invite-link sign-up (2026-11-11): the same
   * code email as every other sign-up, from the dealership for its customers
   * and from Suprah AI for drivers.
   */
  const newUser = (values: Record<string, unknown> = {}) => ({ email: 'maria@example.com', save: jest.fn(), ...values }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: async () => ({ name: 'Action Auto Utah' }) }) });
  });

  it("emails a new 15-minute code from the customer's dealership, with what comes next", async () => {
    const user = newUser({ organizationId: '64b0000000000000000000aa' });
    const before = Date.now();

    await expect(authService.sendSignupCode(user, 'Enter this code to confirm your email and open your customer account with Action Auto Utah.')).resolves.toBe(true);

    expect(user.otpCode).toMatch(/^\d{6}$/);
    expect(new Date(user.otpExpiresAt).getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
    expect(user.save).toHaveBeenCalled();
    const email = mockSendEmail.mock.calls[0][0];
    expect(email.to).toBe('maria@example.com');
    expect(email.subject).toBe('Verify Your Action Auto Utah Account');
    expect(email.text).toContain(`Your code: ${user.otpCode}`);
    expect(email.text).toContain('open your customer account with Action Auto Utah');
  });

  it('a driver gets it from Suprah AI', async () => {
    const user = newUser();
    await authService.sendSignupCode(user, 'Enter this code to confirm your email.');
    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockSendEmail.mock.calls[0][0].subject).toBe('Verify Your Suprah.AI Account');
  });

  it('says when the email could not be sent, and keeps the code for Resend Code', async () => {
    mockSendEmail.mockRejectedValue(new Error('mail server down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = newUser();
    await expect(authService.sendSignupCode(user, 'Enter this code.')).resolves.toBe(false);
    expect(user.otpCode).toMatch(/^\d{6}$/);
    expect(user.save).toHaveBeenCalled();
    spy.mockRestore();
  });
});
