/**
 * A driver approved in the Review Center gets a plain-English, Suprah AI
 * branded email with a sign-in link. Sending never blocks the approval. The
 * email service is a stand-in; nothing is sent.
 */
const mockSendEmail = jest.fn();
jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendEmail: (...args: unknown[]) => mockSendEmail(...args) },
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { driverApprovedEmail, sendDriverApprovedEmail } from '../../src/services/driverApprovalEmail';

beforeEach(() => {
  jest.clearAllMocks();
  mockSendEmail.mockResolvedValue(undefined);
  process.env.FRONTEND_URL = 'https://app.example.com/';
});

describe('driverApprovedEmail', () => {
  it('says what to do next, with the sign-in link', () => {
    const email = driverApprovedEmail('Maria', 'https://app.example.com/sign-in');
    expect(email.subject).toBe("You're approved to drive with Suprah AI");
    expect(email.text).toContain('Hi Maria,');
    expect(email.text).toContain('You can now sign in to the Suprah AI Driver Portal and accept loads.');
    expect(email.text).toContain('Sign in: https://app.example.com/sign-in');
    expect(email.html).toContain('href="https://app.example.com/sign-in"');
  });

  it("never lets a driver's name add markup to the email", () => {
    const email = driverApprovedEmail('<img src=x onerror=alert(1)>', 'https://app.example.com/sign-in');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img');
  });

  it('greets a driver with no name plainly', () => {
    expect(driverApprovedEmail('  ', 'https://x').text).toContain('Hi there,');
  });
});

describe('sendDriverApprovedEmail', () => {
  it("sends to the driver's email with the website's sign-in page", async () => {
    await sendDriverApprovedEmail({ _id: 'driver-1', email: 'maria@example.com', name: 'Maria' });
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'maria@example.com',
      subject: "You're approved to drive with Suprah AI",
    }));
    expect(mockSendEmail.mock.calls[0][0].text).toContain('Sign in: https://app.example.com/sign-in');
  });

  it("skips a driver without an email, and doesn't fail the approval when sending fails", async () => {
    await sendDriverApprovedEmail({ _id: 'driver-1', email: '' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    mockSendEmail.mockRejectedValueOnce(new Error('mail down'));
    await expect(sendDriverApprovedEmail({ _id: 'driver-1', email: 'maria@example.com' })).resolves.toBeUndefined();
  });
});
