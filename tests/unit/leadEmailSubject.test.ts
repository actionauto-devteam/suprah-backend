import {
  MAX_EMAIL_SUBJECT_LENGTH,
  cleanEmailSubject,
  encodeEmailHeader,
  formatEmailFrom,
  resolveLeadEmailSubject,
  threadEmailSubject,
} from '../../src/utils/leadEmailSubject';

describe('lead email subject', () => {
  it('turns line breaks and control characters into spaces so no header can be added', () => {
    expect(cleanEmailSubject('Hello\r\nBcc: someone@example.com')).toBe('Hello Bcc: someone@example.com');
    expect(cleanEmailSubject('  Tabs\tand\u0007bells  ')).toBe('Tabs and bells');
  });

  it('limits the subject length', () => {
    expect(cleanEmailSubject('x'.repeat(500))).toHaveLength(MAX_EMAIL_SUBJECT_LENGTH);
  });

  it('uses the saved thread subject first, then the inquiry subject', () => {
    expect(threadEmailSubject({ emailThreadSubject: 'Your Tacoma photos', subject: 'Tacoma inquiry' })).toBe('Your Tacoma photos');
    expect(threadEmailSubject({ subject: 'Tacoma inquiry' })).toBe('Re: Tacoma inquiry');
    expect(threadEmailSubject({})).toBe('Re: Inquiry Response');
  });

  it('lets staff choose a subject only before an email thread exists', () => {
    expect(resolveLeadEmailSubject({ subject: 'Tacoma inquiry' }, 'New subject')).toEqual({ subject: 'New subject', locked: false });
    expect(resolveLeadEmailSubject({ subject: 'Tacoma inquiry' }, '   ')).toEqual({ subject: 'Re: Tacoma inquiry', locked: false });
    expect(resolveLeadEmailSubject({ subject: 'Tacoma inquiry', threadId: 't1' }, 'New subject')).toEqual({ subject: 'Re: Tacoma inquiry', locked: true });
  });

  it('encodes non-English subjects and leaves plain ones alone', () => {
    expect(encodeEmailHeader('Re: Tacoma inquiry')).toBe('Re: Tacoma inquiry');
    const encoded = encodeEmailHeader('Prueba mañana');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8')).toBe('Prueba mañana');
  });
});

describe('lead email sender', () => {
  const mailbox = 'leads@dealer.example.com';

  it('shows the rep name with the dealership mailbox address', () => {
    expect(formatEmailFrom('Mary Pinero', mailbox)).toBe(`"Mary Pinero" <${mailbox}>`);
    expect(formatEmailFrom('  Beth   Reyes ', mailbox)).toBe(`"Beth Reyes" <${mailbox}>`);
  });

  it('keeps just the address when there is no usable name', () => {
    expect(formatEmailFrom('', mailbox)).toBe(mailbox);
    expect(formatEmailFrom(null, mailbox)).toBe(mailbox);
    expect(formatEmailFrom('mary@dealer.example.com', mailbox)).toBe(mailbox);
  });

  it('removes quotes, brackets and line breaks so the name cannot change other headers', () => {
    expect(formatEmailFrom('Mary "MP" <boss>\r\nX-Test: 1', mailbox)).toBe(`"Mary MP boss X-Test: 1" <${mailbox}>`);
    expect(formatEmailFrom('Mary\r\nBcc: x@example.com', mailbox)).toBe(mailbox);
    expect(formatEmailFrom('Jomalyn\r\nCabillan', mailbox)).toBe(`"Jomalyn Cabillan" <${mailbox}>`);
    expect(formatEmailFrom('Ann "The Closer" Lee', mailbox)).toBe(`"Ann The Closer Lee" <${mailbox}>`);
  });

  it('encodes names with letters outside plain English', () => {
    const from = formatEmailFrom('José Peña', mailbox);
    expect(from).toMatch(new RegExp(`^=\\?UTF-8\\?B\\?.+\\?= <${mailbox.replace(/\./g, '\\.')}>$`));
    expect(Buffer.from(from.slice(10, from.indexOf('?= <')), 'base64').toString('utf8')).toBe('José Peña');
  });

  it('keeps long names short', () => {
    const from = formatEmailFrom('A'.repeat(100), mailbox);
    expect(from).toBe(`"${'A'.repeat(64)}" <${mailbox}>`);
  });
});
