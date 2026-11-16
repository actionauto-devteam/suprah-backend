// Tests from the October 21, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

import { codeEmail } from '../../src/utils/codeEmail';
import { registerSchema, resetPasswordSchema, strongPasswordProblems } from '../../src/validations/auth.validation';
import { describeValidationIssues } from '../../src/utils/userMessages';

describe('codeEmail.test.ts', () => {
  describe('Branded code email', () => {
    const email = codeEmail({ brandName: 'Suprah.AI', heading: 'Your verification code', intro: 'Here is your code again.', code: '482913', minutesLeft: 12 });

    it('carries the Suprah AI name, the code, the expiry and the support contact', () => {
      expect(email.html).toContain('Suprah.AI');
      expect(email.html).toContain('482913');
      expect(email.html).toContain('This code expires in 12 minutes.');
      expect(email.html).toContain('support@suprahai.com');
      expect(email.html).toContain('#10b981');
      expect(email.text).toContain('Your code: 482913');
      expect(email.text).toContain('— Suprah AI');
      expect(email.html).toContain('<strong>Suprah AI</strong>');
    });

    it("a dealership name can't change the email's HTML", () => {
      const dealer = codeEmail({ brandName: 'A&B <Motors>', heading: 'Verify your email', intro: 'Welcome!', code: '111222', minutesLeft: 15 });
      expect(dealer.html).toContain('A&amp;B &lt;Motors&gt;');
      expect(dealer.html).not.toContain('<Motors>');
    });
  });
});

describe('passwordRules.test.ts', () => {
  const signUp = (password: string, role?: string) =>
    registerSchema.safeParse({ name: 'New Person', email: 'new.person@example.com', password, ...(role ? { role } : {}) });

  describe('Password rules for new accounts', () => {
    it('every new account needs an uppercase letter, a number and a symbol', () => {
      for (const role of [undefined, 'customer', 'driver', 'dealership']) {
        const parsed = signUp('password12345', role);
        expect(parsed.success).toBe(false);
        if (parsed.success) continue;
        expect(describeValidationIssues(parsed.error.issues)).toBe(
          'Please fix the following: Password must include at least one uppercase letter. Password must include at least one special character.',
        );
      }
    });

    it('lists every rule a short password misses, at once', () => {
      const parsed = signUp('abc');
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(describeValidationIssues(parsed.error.issues)).toBe(
        'Please fix the following: Password must be at least 8 characters. Password must include at least one uppercase letter. Password must include at least one number. Password must include at least one special character.',
      );
    });

    it('a password that meets every rule is accepted', () => {
      expect(signUp('Strong-Passw0rd!').success).toBe(true);
      expect(signUp('Strong-Passw0rd!', 'driver').success).toBe(true);
      expect(strongPasswordProblems('Strong-Passw0rd!')).toEqual([]);
    });

    it('password reset uses the same rules', () => {
      const weak = resetPasswordSchema.safeParse({ email: 'a@example.com', otp: '123456', newPassword: 'password12345' });
      expect(weak.success).toBe(false);
      const strong = resetPasswordSchema.safeParse({ email: 'a@example.com', otp: '123456', newPassword: 'Strong-Passw0rd!' });
      expect(strong.success).toBe(true);
    });
  });
});
