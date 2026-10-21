import { registerSchema, resetPasswordSchema, strongPasswordProblems } from '../../src/validations/auth.validation';
import { describeValidationIssues } from '../../src/utils/userMessages';

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
