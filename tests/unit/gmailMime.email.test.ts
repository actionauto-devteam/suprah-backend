const mockGmailSend = jest.fn().mockResolvedValue({ data: { id: 'gmail-1' } });
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'smtp-1' });
const mockOrgLeadConfigFindOne = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn() })) },
    gmail: () => ({ users: { messages: { send: mockGmailSend } } }),
  },
}));
jest.mock('../../src/utils/crypto', () => ({ decrypt: () => 'refresh-token' }));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({ __esModule: true, default: { findOne: mockOrgLeadConfigFindOne } }));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: {
    findById: () => ({
      select: () => ({ lean: () => Promise.resolve({ name: 'Action Auto Utah', metadata: { physicalMailingAddress: '123 Main St, Lehi UT' } }) }),
    }),
  },
}));
jest.mock('../../src/models/EmailOptOut.model', () => ({
  __esModule: true,
  default: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}));
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findById: () => ({ select: () => ({ lean: () => ({ catch: () => Promise.resolve(null) }) }) }) },
}));
jest.mock('../../src/services/communication.service', () => ({ resolveReviewLink: jest.fn().mockResolvedValue('https://g.page/review') }));
jest.mock('../../src/utils/aiOutboundSafety', () => ({ isLocalUiAcceptanceMode: () => false }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import config from '../../src/config';
import emailService, { buildGmailRawMessage } from '../../src/services/email.service';

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function decodeQuotedPrintable(value: string): string {
  const joined = value.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /^[0-9A-F]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function partBody(mime: string, contentType: string): string {
  const start = mime.indexOf(`Content-Type: ${contentType}`);
  if (start === -1) return '';
  const headerEnd = mime.indexOf('\r\n\r\n', start);
  const header = mime.slice(start, headerEnd);
  const bodyEnd = mime.indexOf('\r\n----', headerEnd);
  const body = mime.slice(headerEnd + 4, bodyEnd === -1 ? undefined : bodyEnd);
  if (/Content-Transfer-Encoding: quoted-printable/i.test(header)) return decodeQuotedPrintable(body);
  if (/Content-Transfer-Encoding: base64/i.test(header)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

function topHeaders(mime: string): string {
  return mime.slice(0, mime.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/g, ' ');
}

function longestLine(mime: string): number {
  return Math.max(...mime.split('\r\n').map((line) => Buffer.byteLength(line)));
}

const R2 = 'https://pub-0123456789abcdef0123456789abcdef.r2.dev';
const LONG_BODY = `<p>Hi <strong>{firstName}</strong>, we’re excited — come see us!</p><p>${'Plenty of detail here. '.repeat(60)}</p><img src="${R2}/email-campaigns/org/1760931234567-123456789.png" style="max-width:100%;height:auto;display:block;margin:8px 0;border-radius:4px;" />`;

describe('shared Gmail API MIME builder', () => {
  const originalBackendUrl = (config as any).backendUrl;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgLeadConfigFindOne.mockResolvedValue({ refreshToken: 'enc', gmailConnected: true, isActive: true });
    (config as any).backendUrl = 'https://api.suprah-app.com';
  });

  afterAll(() => {
    (config as any).backendUrl = originalBackendUrl;
  });

  it('keeps every line within the 998-byte limit and encodes non-ASCII safely', async () => {
    const html = `<p>${'x'.repeat(4000)} — “quoted” café</p>`;
    const mime = decodeRaw(await buildGmailRawMessage({ to: 'a@example.com', subject: 'Hi', text: 'plain ’', html }));
    expect(longestLine(mime)).toBeLessThanOrEqual(998);
    expect(mime).not.toMatch(/Content-Transfer-Encoding: 7bit\r\n\r\n<p>/);
    expect(partBody(mime, 'text/html')).toBe(html);
    expect(partBody(mime, 'text/plain')).toBe('plain ’');
  });

  it('encodes a non-ASCII subject per RFC 2047', async () => {
    const mime = decodeRaw(await buildGmailRawMessage({ to: 'a@example.com', subject: 'Héllo — 50% off', text: 't', html: '<p>h</p>' }));
    const subjectLine = topHeaders(mime).split('\r\n').find((line) => line.startsWith('Subject:')) || '';
    expect(subjectLine).toMatch(/=\?UTF-8\?/);
    expect(/[^\x00-\x7F]/.test(topHeaders(mime))).toBe(false);
  });

  it('keeps the multipart/alternative structure with a plain-text alternative, and no From or Message-ID so Gmail sets them', async () => {
    const mime = decodeRaw(await buildGmailRawMessage({ to: 'a@example.com', subject: 'Hi', text: 'Plain version', html: '<p>HTML version</p>' }));
    const headers = topHeaders(mime);
    expect(headers).toMatch(/Content-Type: multipart\/alternative/);
    expect(headers).not.toMatch(/^From:/m);
    expect(headers).not.toMatch(/^Message-ID:/im);
    expect(headers).toMatch(/^To: a@example\.com/m);
  });

  it('falls back to the text as the HTML part when no HTML is given, like before', async () => {
    const mime = decodeRaw(await buildGmailRawMessage({ to: 'a@example.com', subject: 'Hi', text: 'Only text' }));
    expect(partBody(mime, 'text/html')).toBe('Only text');
  });

  it('keeps calendar invites as a text/calendar METHOD=REQUEST alternative part', async () => {
    const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR';
    const mime = decodeRaw(await buildGmailRawMessage({ to: 'a@example.com', subject: 'Invite', text: 't', html: '<p>h</p>', icalEvent: { toString: () => ics } }));
    expect(mime).toMatch(/Content-Type: text\/calendar; charset="?utf-8"?; method=REQUEST/i);
    expect(partBody(mime, 'text/calendar')).toContain('METHOD:REQUEST');
  });

  it('passes custom headers through and never reads local files or URLs into the message', async () => {
    const mime = decodeRaw(await buildGmailRawMessage({
      to: 'a@example.com', subject: 'Hi', text: 't', html: '<img src="https://example.com/a.png" />',
      headers: { 'List-Unsubscribe': '<https://x.example/u>' },
    }));
    expect(topHeaders(mime)).toMatch(/^List-Unsubscribe: <https:\/\/x\.example\/u>/m);
    expect(partBody(mime, 'text/html')).toContain('<img src="https://example.com/a.png" />');
  });

  it('campaign email: banner and inline images, alt text, greeting name and one-click unsubscribe headers survive end to end', async () => {
    await emailService.sendCampaignEmail({
      to: 'jordan@example.com',
      customerName: 'Mary Ann Cruz',
      greetingName: 'Mary Ann',
      subject: 'Hi {firstName}, new arrivals — this week',
      greetingText: 'Hi {firstName},',
      bannerImageUrl: `${R2}/email-campaigns/org/banner.jpg`,
      bodyText: 'fallback',
      bodyHtml: LONG_BODY,
      organizationId: 'org-1',
    });
    expect(mockGmailSend).toHaveBeenCalledTimes(1);
    const mime = decodeRaw(mockGmailSend.mock.calls[0][0].requestBody.raw);
    const html = partBody(mime, 'text/html');
    expect(longestLine(mime)).toBeLessThanOrEqual(998);
    expect(html).toContain(`<img src="${R2}/email-campaigns/org/banner.jpg" alt="Action Auto Utah"`);
    expect(html).toContain(`<img src="${R2}/email-campaigns/org/1760931234567-123456789.png"`);
    expect(html).toContain('alt="Image from Action Auto Utah"');
    expect(html).toContain('Hi Mary Ann,');
    expect(html).toContain('we’re excited — come see us!');
    const headers = topHeaders(mime);
    expect(headers).toMatch(/^List-Unsubscribe: <https:\/\/api\.suprah-app\.com\/api\/email\/unsubscribe\?token=/m);
    expect(headers).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
    expect(headers).toMatch(/^Subject: =\?UTF-8\?/m);
  });

  it('campaign email: no List-Unsubscribe header when the unsubscribe link would not be https (for example localhost)', async () => {
    (config as any).backendUrl = 'http://localhost:5000';
    await emailService.sendCampaignEmail({
      to: 'jordan@example.com', customerName: 'there', subject: 'Hi', greetingText: 'Hi {firstName},',
      bodyText: 'Body', organizationId: 'org-1',
    });
    const mime = decodeRaw(mockGmailSend.mock.calls[0][0].requestBody.raw);
    expect(topHeaders(mime)).not.toMatch(/List-Unsubscribe/i);
  });

  it('appointment reminders still send through Gmail with valid MIME and no marketing unsubscribe header', async () => {
    await emailService.sendAppointmentReminder(
      { title: 'Test drive — 2022 Civic', startTime: new Date('2026-10-21T17:00:00Z'), endTime: new Date('2026-10-21T18:00:00Z'), location: 'Lehi' } as any,
      'jordan@example.com',
      'Jordan',
      'org-1',
    );
    expect(mockGmailSend).toHaveBeenCalledTimes(1);
    const mime = decodeRaw(mockGmailSend.mock.calls[0][0].requestBody.raw);
    expect(longestLine(mime)).toBeLessThanOrEqual(998);
    expect(topHeaders(mime)).not.toMatch(/List-Unsubscribe/i);
    expect(partBody(mime, 'text/html')).toContain('Jordan');
  });

  it('review request emails still send through Gmail with valid MIME and no marketing unsubscribe header', async () => {
    await emailService.sendReviewRequestEmail({
      organizationId: 'org-1',
      customerBooking: { email: 'jordan@example.com', firstName: 'Jordan' },
    });
    expect(mockGmailSend).toHaveBeenCalledTimes(1);
    const mime = decodeRaw(mockGmailSend.mock.calls[0][0].requestBody.raw);
    expect(longestLine(mime)).toBeLessThanOrEqual(998);
    expect(topHeaders(mime)).not.toMatch(/List-Unsubscribe/i);
    expect(partBody(mime, 'text/html')).toContain('https://g.page/review');
  });

  it('SMTP fallback carries the campaign headers too', async () => {
    mockOrgLeadConfigFindOne.mockResolvedValue(null);
    await emailService.sendCampaignEmail({
      to: 'jordan@example.com', customerName: 'Jordan', subject: 'Hi', greetingText: 'Hi {firstName},',
      bodyText: 'Body', organizationId: 'org-1',
    });
    expect(mockGmailSend).not.toHaveBeenCalled();
    expect(mockSendMail.mock.calls[0][0].headers).toMatchObject({ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  });
});

describe('campaign greeting name', () => {
  it('uses the stored first name, keeps multi-word first names, and falls back to there', async () => {
    const { resolveCampaignGreetingName, campaignGreetingNameFor } = await import('../../src/services/email.service');
    expect(campaignGreetingNameFor('Mary Ann')).toBe('Mary Ann');
    expect(campaignGreetingNameFor('  ')).toBe('there');
    expect(campaignGreetingNameFor(undefined)).toBe('there');
    expect(resolveCampaignGreetingName({ greetingName: 'Mary Ann', customerName: 'Mary Ann Cruz' })).toBe('Mary Ann');
    expect(resolveCampaignGreetingName({ greetingName: 'there', customerName: 'Narvaez' })).toBe('there');
    expect(resolveCampaignGreetingName({ customerName: 'Jordan Lee' })).toBe('Jordan');
    expect(resolveCampaignGreetingName({ customerName: '' })).toBe('there');
  });
});
