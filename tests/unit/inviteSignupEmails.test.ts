/**
 * Emails after signing up with a driver or customer invite link (2026-11-11).
 */
import { customerWelcomeEmail, driverApplicationEmail, EMAIL_ALREADY_HAS_ACCOUNT } from '../../src/utils/inviteSignupEmails';

const SIGN_IN = 'https://www.suprah-app.com/sign-in?email=sam%40example.com&redirect_url=%2Fdriver%2Fpending';

describe('invite link sign-up emails', () => {
  it('the driver email says to sign in and finish the application, with a link that goes there', () => {
    const email = driverApplicationEmail({ name: ' Sam ', email: 'sam@example.com', signInUrl: SIGN_IN, supportEmail: 'support@suprahai.com' });
    expect(email.subject).toBe('Driver account created: finish your application');
    for (const part of [email.text, email.html]) {
      expect(part).toContain('sign in and finish your application');
      expect(part).toContain('upload your documents');
      expect(part).toContain(SIGN_IN);
    }
    expect(email.html).toContain('Hello <strong>Sam</strong>');
  });

  it('the customer email never contains a password and points to sign-in', () => {
    const email = customerWelcomeEmail({ name: 'Maria', email: 'maria@example.com', orgName: 'Action Auto Utah', signInUrl: 'https://x/sign-in' });
    expect(email.subject).toBe('Welcome to Action Auto Utah: your account is ready');
    expect(email.text).toContain('the password you chose');
    expect(`${email.text}${email.html}`).not.toMatch(/Password:/i);
    expect(email.html).toContain('https://x/sign-in');
  });

  it('names typed into the form are shown as text, not HTML', () => {
    const email = customerWelcomeEmail({ name: '<b>Maria</b>', email: 'maria@example.com', orgName: 'A & B Motors', signInUrl: 'https://x' });
    expect(email.html).toContain('&lt;b&gt;Maria&lt;/b&gt;');
    expect(email.html).toContain('A &amp; B Motors');
  });

  it('an email that already has an account is told to sign in instead', () => {
    expect(EMAIL_ALREADY_HAS_ACCOUNT).toMatch(/^This email already has a Suprah AI account\. Sign in instead/);
  });
});
