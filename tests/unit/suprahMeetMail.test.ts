const sendMail = jest.fn();
const createTransport = jest.fn(() => ({ sendMail }));
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport } }));
import { mailConfigured, sendRecordingEmail } from '../../src/services/suprahMeetMail.service';

const original = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^(MEET_SMTP_|SMTP_)/.test(key)) delete process.env[key];
  process.env.SMTP_HOST = 'smtp.example.test'; process.env.SMTP_USER = 'meet@example.test';
  sendMail.mockResolvedValue({ accepted: ['person@example.test'], rejected: [] });
});
afterAll(() => { process.env = original; });
const options = { to: 'person@example.test', recipientName: 'Taylor', meetingTitle: '<HR> planning',
  code: 'MEET-1234', whenStr: 'Nov 12, 2026', durationMin: 20,
  link: 'https://app.example.test/meet/recording/MEET-1234?t=token',
  summary: { overview: 'Decided <next steps>', keyPoints: ['A & B'], decisions: [], actionItems: ['Send report'] } };

it('uses the shared SMTP sender when dedicated Meet SMTP is absent', async () => {
  expect(mailConfigured()).toBe(true);
  await sendRecordingEmail(options);
  expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test', connectionTimeout: 15000 }));
  expect(sendMail.mock.calls.at(-1)[0]).toMatchObject({ from: 'meet@example.test', to: options.to });
});
it('includes safe HTML and plain text, and supports summary-only reports', async () => {
  await sendRecordingEmail({ ...options, recordingAvailable: false });
  const message = sendMail.mock.calls.at(-1)[0];
  expect(message.html).toContain('&lt;HR&gt;');
  expect(message.html).toContain('Read the meeting summary');
  expect(message.text).toContain('Send report');
  expect(message.subject).toMatch(/^AI summary/);
});
it('rejects a recipient the mail server did not accept', async () => {
  sendMail.mockResolvedValue({ accepted: [], rejected: [options.to] });
  await expect(sendRecordingEmail(options)).rejects.toThrow('did not accept');
});
it('does not claim email is configured when a sender or host is missing', () => {
  delete process.env.SMTP_HOST;
  expect(mailConfigured()).toBe(false);
});
