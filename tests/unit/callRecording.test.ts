jest.mock('../../src/services/telnyx.service', () => ({ recordingCommand: jest.fn(), recordingDisclosure: jest.fn(), findRecordings: jest.fn(), deleteProviderRecording: jest.fn() }));
jest.mock('../../src/config', () => ({ __esModule: true, default: { r2: {} } }));
import { addCalendarMonths, recordingSettingsInput, decodeRecordingState, recordingReady } from '../../src/services/callRecording.service';
import { validateRecordingUrl } from '../../src/services/callRecordingStorage.service';

describe('Recording settings and hard boundaries', () => {
  it('accepts a short announcement and a retention between 1 and 120 months', () => {
    expect(recordingSettingsInput.parse({ announcementText: '  This call is now being recorded.  ', retentionMonths: 6 })).toEqual({ announcementText: 'This call is now being recorded.', retentionMonths: 6 });
  });
  it.each([[{ announcementText: '', retentionMonths: 6 }], [{ announcementText: 'x'.repeat(301), retentionMonths: 6 }], [{ announcementText: 'ok', retentionMonths: 0 }], [{ announcementText: 'ok', retentionMonths: 121 }], [{ announcementText: 'ok', retentionMonths: 1.5 }], [{ announcementText: 'ok', retentionMonths: 6, enabled: true }]])('rejects %j', input => {
    expect(recordingSettingsInput.safeParse(input).success).toBe(false);
  });
  it.each([['2026-08-31T12:00:00Z', 6, '2027-02-28T12:00:00.000Z'], ['2023-08-31T12:00:00Z', 6, '2024-02-29T12:00:00.000Z'], ['2026-10-03T12:34:56Z', 6, '2027-04-03T12:34:56.000Z']])('calendar retention clamps %s', (date, months, expected) => expect(addCalendarMonths(new Date(date), Number(months)).toISOString()).toBe(expected));
  it.each(['http://s3.amazonaws.com/file', 'https://127.0.0.1/file', 'https://s3.amazonaws.com.evil.test/file', 'https://user@s3.amazonaws.com/file', 'https://s3.amazonaws.com:8443/file', 'https://example.com/file'])('rejects untrusted storage URL %s', url => expect(() => validateRecordingUrl(url)).toThrow());
  it('accepts official regional provider S3 URLs', () => expect(validateRecordingUrl('https://bucket.s3.us-east-1.amazonaws.com/audio.mp3').protocol).toBe('https:'));
  it('ignores malformed client state', () => expect(decodeRecordingState('bad')).toBeNull());
  const ready = { status: 'in-progress', direction: 'inbound', recordingCorrelation: { verified: true, answerControlId: 'c', connectionId: 'connection', bridged: true } };
  it('a connected browser call is ready to record', () => expect(recordingReady(ready)).toBe(true));
  it.each([
    { ...ready, status: 'ringing' },
    { ...ready, answeredVia: 'phone' },
    { ...ready, recordingCorrelation: { ...ready.recordingCorrelation, verified: false } },
    { ...ready, recordingCorrelation: { ...ready.recordingCorrelation, answerControlId: '' } },
    { ...ready, recordingCorrelation: { ...ready.recordingCorrelation, connectionId: '' } },
    { ...ready, recordingCorrelation: { ...ready.recordingCorrelation, bridged: false } },
    { ...ready, recordingCorrelation: undefined },
  ])('is not ready for %j', call => expect(recordingReady(call)).toBe(false));
  it('outbound calls do not need a bridge', () => expect(recordingReady({ ...ready, direction: 'outbound', recordingCorrelation: { ...ready.recordingCorrelation, bridged: false } })).toBe(true));
});
