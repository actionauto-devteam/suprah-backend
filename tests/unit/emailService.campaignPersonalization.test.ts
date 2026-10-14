const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'msg-1' });
const mockCreateTransport = jest.fn().mockReturnValue({ sendMail: mockSendMail });
const mockOrgLeadConfigFindOne = jest.fn().mockResolvedValue(null);
const mockOrganizationFindById = jest.fn();
const mockEmailOptOutFindOne = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: mockCreateTransport },
}));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({
  __esModule: true,
  default: { findOne: mockOrgLeadConfigFindOne },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrganizationFindById },
}));
jest.mock('../../src/models/EmailOptOut.model', () => ({
  __esModule: true,
  default: { findOne: mockEmailOptOutFindOne },
}));
jest.mock('../../src/services/communication.service', () => ({
  resolveReviewLink: jest.fn(),
}));
jest.mock('../../src/utils/aiOutboundSafety', () => ({
  isLocalUiAcceptanceMode: jest.fn().mockReturnValue(false),
}));

import emailService from '../../src/services/email.service';

function chainableLean(result: any) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) };
}

describe('email.service — sendCampaignEmail {firstName} personalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgLeadConfigFindOne.mockResolvedValue(null);
    mockOrganizationFindById.mockReturnValue(chainableLean({ metadata: { physicalMailingAddress: '123 Main St' }, name: 'Test Dealership' }));
    mockEmailOptOutFindOne.mockReturnValue(chainableLean(null));
  });

  it('substitutes a normal {firstName} identically in the subject, html body, and plain-text body', async () => {
    const delivered = await emailService.sendCampaignEmail({
      to: 'jordan@example.com',
      customerName: 'Jordan Smith',
      subject: 'Hi {firstName}, check this out',
      greetingText: 'Hey {firstName}!',
      bodyText: 'Thanks for stopping by, {firstName}.',
      organizationId: 'org-1',
    });

    expect(delivered).toBe(true);
    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.subject).toBe('Hi Jordan, check this out');
    expect(mailOptions.text).toContain('Hey Jordan!');
    expect(mailOptions.text).toContain('Thanks for stopping by, Jordan.');
    expect(mailOptions.html).toContain('Hey Jordan!');
    expect(mailOptions.html).toContain('Thanks for stopping by, Jordan.');
  });

  it('keeps rich-text bodyHtml formatting tags intact across personalization', async () => {
    await emailService.sendCampaignEmail({
      to: 'jordan@example.com',
      customerName: 'Jordan',
      subject: 'Subject',
      greetingText: 'Hi {firstName},',
      bodyText: 'Thanks, {firstName}.',
      bodyHtml: '<p>Hi <strong>{firstName}</strong>, here is an <a href="https://example.com">update</a>.</p>',
      organizationId: 'org-1',
    });

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.html).toContain('<p>Hi <strong>Jordan</strong>, here is an <a href="https://example.com">update</a>.</p>');
  });

  it('HTML-escapes a crafted contact name before inserting it into the HTML body, but keeps it literal in the subject and plain-text body', async () => {
    await emailService.sendCampaignEmail({
      to: 'attacker@example.com',
      customerName: '<svg/onload=alert(1)>',
      subject: 'Hi {firstName}',
      greetingText: 'Hi {firstName},',
      bodyText: 'Welcome, {firstName}.',
      bodyHtml: '<p>Welcome, {firstName}.</p>',
      organizationId: 'org-1',
    });

    const mailOptions = mockSendMail.mock.calls[0][0];

    expect(mailOptions.subject).toBe('Hi <svg/onload=alert(1)>');
    expect(mailOptions.text).toContain('Hi <svg/onload=alert(1)>,');

    expect(mailOptions.html).not.toContain('<svg/onload=alert(1)>');
    expect(mailOptions.html).not.toContain('<svg');
    expect(mailOptions.html).toContain('&lt;svg/onload=alert(1)&gt;');
  });

  it('HTML-escapes a crafted contact name in the plain-text fallback body too (when no bodyHtml is set)', async () => {
    await emailService.sendCampaignEmail({
      to: 'attacker@example.com',
      customerName: '<script>alert(1)</script>',
      subject: 'Subject',
      greetingText: 'Greeting',
      bodyText: 'Hi {firstName}, welcome.',
      organizationId: 'org-1',
    });

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.html).not.toContain('<script>alert(1)</script>');
    expect(mailOptions.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
