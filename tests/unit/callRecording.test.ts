jest.mock('../../src/services/telnyx.service', () => ({ recordingCommand: jest.fn(), recordingDisclosure: jest.fn(), findRecordings: jest.fn(), deleteProviderRecording: jest.fn() }));
jest.mock('../../src/config', () => ({ __esModule: true, default: { r2: {} } }));
import { addCalendarMonths, recordingPolicyInput, decodeRecordingState, maybeStartRecording } from '../../src/services/callRecording.service';
import { validateRecordingUrl } from '../../src/services/callRecordingStorage.service';
import { CallLog } from '../../src/models/communication.model';
import * as telnyx from '../../src/services/telnyx.service';

describe('Recording policy and hard boundaries', () => {
  afterEach(() => jest.restoreAllMocks());
  const base = { name: 'Test', number: '+18015550100', direction: 'inbound' };
  it('defaults to disabled and six calendar months', () => {
    const p = recordingPolicyInput.parse(base);
    expect(p.enabled).toBe(false); expect(p.retentionMonths).toBe(6);
  });
  it.each(['legalApproved', 'providerVerified', 'connectionId', 'disclosureOwner', 'consentMode'])('does not enable with missing %s', key => {
    const p: any = { ...base, enabled: true, legalApproved: true, providerVerified: true, connectionId: 'connection', disclosureOwner: 'suprah', disclosureText: 'Approved notice', consentMode: 'notice' };
    p[key] = key.endsWith('Approved') || key.endsWith('Verified') ? false : key === 'connectionId' ? '' : 'pending';
    expect(recordingPolicyInput.safeParse(p).success).toBe(false);
  });
  it('requires independent confirmation of provider-owned notice', () => {
    expect(recordingPolicyInput.safeParse({ ...base, enabled: true, legalApproved: true, providerVerified: true, connectionId: 'c', disclosureOwner: 'provider', consentMode: 'notice' }).success).toBe(false);
  });
  it.each([['2026-08-31T12:00:00Z', 6, '2027-02-28T12:00:00.000Z'], ['2023-08-31T12:00:00Z', 6, '2024-02-29T12:00:00.000Z'], ['2026-10-03T12:34:56Z', 6, '2027-04-03T12:34:56.000Z']])('calendar retention clamps %s', (date, months, expected) => expect(addCalendarMonths(new Date(date), Number(months)).toISOString()).toBe(expected));
  it.each(['http://s3.amazonaws.com/file', 'https://127.0.0.1/file', 'https://s3.amazonaws.com.evil.test/file', 'https://user@s3.amazonaws.com/file', 'https://s3.amazonaws.com:8443/file', 'https://example.com/file'])('rejects untrusted storage URL %s', url => expect(() => validateRecordingUrl(url)).toThrow());
  it('accepts official regional provider S3 URLs', () => expect(validateRecordingUrl('https://bucket.s3.us-east-1.amazonaws.com/audio.mp3').protocol).toBe('https:'));
  it('ignores malformed client state', () => expect(decodeRecordingState('bad')).toBeNull());
  it.each([{ status: 'in-progress' }, { status: 'ivr', recordingCorrelation: { verified: true, answerControlId: 'c', bridged: true } }, { status: 'in-progress', recordingCorrelation: { verified: true, answerControlId: 'c', bridged: false } }])('never starts from browser/IVR/unbridged evidence %j', async evidence => {
    jest.spyOn(CallLog, 'findById').mockReturnValue({ select: async () => ({ direction: 'inbound', ...evidence }) } as any);
    await maybeStartRecording('call'); expect(telnyx.recordingCommand).not.toHaveBeenCalled();
  });
});
