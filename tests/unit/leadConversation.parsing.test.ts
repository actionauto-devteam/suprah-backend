import { extractGmailText, gmailAttachmentNames, stripQuotedReply } from '../../src/utils/gmailMessageParser';
import { parseGmailThreadMessages, smsDeliveryStatus } from '../../src/services/leadConversation.service';

const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

const message = (payload: any, extra: Record<string, unknown> = {}) => ({ id: 'm1', internalDate: '1760000000000', payload, ...extra });

describe('Gmail parsing for the conversation timeline', () => {
  it('reads plain text from a nested multipart message', () => {
    const msg = message({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64('Is the truck still available?') } },
          { mimeType: 'text/html', body: { data: b64('<p>Is the truck still available?</p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'quote.pdf', body: { attachmentId: 'a1' } },
      ],
    });
    expect(extractGmailText(msg)).toBe('Is the truck still available?');
    expect(gmailAttachmentNames(msg)).toEqual(['quote.pdf']);
  });

  it('turns an HTML-only email into readable text', () => {
    const msg = message({
      mimeType: 'text/html',
      body: { data: b64('<html><head><style>p{}</style></head><body><p>Hello&nbsp;there</p><br>See you &amp; thanks<ul><li>One</li></ul></body></html>') },
    });
    expect(extractGmailText(msg)).toBe('Hello there\n\nSee you & thanks\n- One');
  });

  it('drops the quoted earlier conversation from a reply but never empties the message', () => {
    expect(stripQuotedReply('Sounds good!\n\nOn Tue, Oct 21, 2026 at 3:00 PM Sales <sales@dealer.com> wrote:\n> Are you coming in?')).toBe('Sounds good!');
    expect(stripQuotedReply('Thanks\n> quoted line')).toBe('Thanks');
    expect(stripQuotedReply('> only quoted text')).toBe('> only quoted text');
  });

  it('marks the dealership’s own messages as sent regardless of letter case or the SENT label', () => {
    const own = message({ headers: [{ name: 'From', value: 'Sales <Sales@Dealer.com>' }], mimeType: 'text/plain', body: { data: b64('Hi') } }, { id: 'own' });
    const labelled = message({ headers: [{ name: 'From', value: 'Alias <alias@dealer.com>' }], mimeType: 'text/plain', body: { data: b64('Hi') } }, { id: 'sent', labelIds: ['SENT'] });
    const customer = message({ headers: [{ name: 'FROM', value: '"Pat Lee" <pat@example.com>' }, { name: 'subject', value: 'Re: Truck' }], mimeType: 'text/plain', body: { data: b64('Yes please') } }, { id: 'cust' });
    const parsed = parseGmailThreadMessages([own, labelled, customer], ['sales@dealer.com']);
    expect(parsed.map((entry) => entry.direction)).toEqual(['outbound', 'outbound', 'inbound']);
    expect(parsed[2]).toMatchObject({ fromName: 'Pat Lee', from: 'pat@example.com', subject: 'Re: Truck', body: 'Yes please' });
  });
});

describe('text delivery labels', () => {
  it.each([
    [{ direction: 'outbound', status: 'queued' }, 'sending', 'Sending'],
    [{ direction: 'outbound', status: 'sent' }, 'sent', 'Sent'],
    [{ direction: 'outbound', status: 'delivered' }, 'delivered', 'Delivered'],
    [{ direction: 'outbound', status: 'failed' }, 'failed', 'Failed'],
    [{ direction: 'outbound', status: 'pending_reconciliation' }, 'unconfirmed', "Couldn't confirm delivery"],
    [{ direction: 'inbound', status: 'received' }, 'received', 'Received'],
  ])('maps %j to %s', (input, code, label) => {
    expect(smsDeliveryStatus(input)).toMatchObject({ code, label });
  });

  it('explains a failed text in plain language and keeps the technical detail separate', () => {
    const status = smsDeliveryStatus({ direction: 'outbound', status: 'failed', errorDetail: 'Number is a landline' });
    expect(status.failureMessage).toBeTruthy();
    expect(status.errorDetail).toBe('Number is a landline');
  });
});
