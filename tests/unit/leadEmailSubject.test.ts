import {
  MAX_EMAIL_SUBJECT_LENGTH,
  cleanEmailSubject,
  encodeEmailHeader,
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
