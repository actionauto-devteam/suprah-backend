/**
 * The first 6-digit code for an invite-link sign-up (2026-11-11): the same
 * code email as every other sign-up, from the dealership for its customers
 * and from Suprah AI for drivers.
 */
const mockSendEmail = jest.fn();
const mockOrgFindById = jest.fn();

jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Session.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/services/token.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/driverApplication.service', () => ({ findOrCreatePendingDriverRequest: jest.fn() }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: { sendEmail: mockSendEmail } }));

import authService from '../../src/services/auth.service';

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
