import mongoose from 'mongoose';
import { INTERNAL_IDEMPOTENT_SIDE_EFFECTS, resolveInquiryIdentity } from '../../src/services/leadInquiry.service';

describe('inquiry identity strength', () => {
  it('treats provider ids, strong fingerprints, texts, calls and chat sessions as reliable event identity', () => {
    expect(resolveInquiryIdentity({ providerInquiryKey: 'carfax:1' })).toBe('event');
    expect(resolveInquiryIdentity({}, 'inquiry:abc')).toBe('event');
    expect(resolveInquiryIdentity({ smsProviderMessageId: 'tx-1' })).toBe('event');
    expect(resolveInquiryIdentity({ callControlId: 'call-1' })).toBe('event');
    expect(resolveInquiryIdentity({ webchatSessionId: new mongoose.Types.ObjectId() })).toBe('event');
    expect(resolveInquiryIdentity({ gmailMessageId: 'gm-1', providerInquiryKey: 'carfax:1' })).toBe('event');
  });

  it('treats a Gmail message id alone as transport identity, so the content window still applies', () => {
    expect(resolveInquiryIdentity({ gmailMessageId: 'gm-1', gmailThreadId: 'thread-1' })).toBe('transport');
  });

  it('reports no identity when nothing reliable is present', () => {
    expect(resolveInquiryIdentity({})).toBe('none');
    expect(resolveInquiryIdentity({ gmailThreadId: 'thread-1', webchatSessionId: 'not-an-id' })).toBe('none');
    expect(resolveInquiryIdentity({ providerInquiryKey: '   ' }, '  ')).toBe('none');
  });

  it('only allows internal side effects to be retried after an expired claim', () => {
    expect(INTERNAL_IDEMPOTENT_SIDE_EFFECTS).toEqual(['conversationRecord', 'notification']);
  });
});
