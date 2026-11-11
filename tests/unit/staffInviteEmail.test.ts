/**
 * The staff invitation email (2026-11-11): names typed by people can't add
 * links, buttons or email headers, and the email still says who invited them,
 * to which dealership, with the link.
 */
import { staffInviteEmail } from '../../src/utils/staffInviteEmail';

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
