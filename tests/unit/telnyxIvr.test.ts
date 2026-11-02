import * as telnyx from '../../src/services/telnyx.service';

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => '{"data":{"result":"ok"}}' } as Response);
});
afterEach(() => jest.restoreAllMocks());

describe('Telnyx IVR commands without live provider access', () => {
  it('answers with IVR customer metadata and a bounded request', async () => {
    await telnyx.answerCall('control', { kind: 'ivr-customer', callLogId: 'log' });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain('/calls/control/actions/answer'); expect(request.signal).toBeDefined();
    expect(JSON.parse(Buffer.from(JSON.parse(request.body).client_state, 'base64').toString())).toMatchObject({ kind: 'ivr-customer' });
  });
  it('collects one DTMF digit with application-controlled retries and correlation', async () => {
    await telnyx.gatherIvr('control', 'Menu', '01234', { kind: 'ivr-menu', callLogId: 'log', revision: 1 });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain('/actions/gather_using_speak');
    expect(JSON.parse(request.body)).toMatchObject({ valid_digits: '01234', maximum_digits: 1, maximum_tries: 1, command_id: 'ivr-menu-log-1' });
  });
  it('speaks the greeting with the clearer voice, a louder level and a pause so the start is not lost', async () => {
    await telnyx.gatherIvr('control', 'Thank you for calling. Press 1 for Sales.', '1', { kind: 'ivr-menu', callLogId: 'log', revision: 1 }, 2000);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ voice: 'AWS.Polly.Joanna-Neural', payload_type: 'ssml' });
    expect(body.payload).toBe('<speak><break time="2000ms"/><prosody volume="+6dB">Thank you for calling. Press 1 for Sales.</prosody></speak>');
  });
  it('keeps special characters in the greeting from breaking the speech', async () => {
    await telnyx.gatherIvr('control', 'Parts & Service <Orem>', '1', { kind: 'ivr-menu', callLogId: 'log', revision: 1 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload).toContain('Parts &amp; Service &lt;Orem&gt;');
  });
  it('a greeting at the length limit still goes out as plain text', async () => {
    const greeting = 'a'.repeat(3000);
    await telnyx.gatherIvr('control', greeting, '1', { kind: 'ivr-menu', callLogId: 'log', revision: 1 }, 2000);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.payload).toBe(greeting);
    expect(body.payload_type).toBeUndefined();
  });
  it('falls back to the standard voice with a new command id when Telnyx refuses the voice', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"errors":[{"detail":"voice"}]}' } as Response);
    await telnyx.gatherIvr('control', 'Menu', '1', { kind: 'ivr-menu', callLogId: 'log', revision: 1 }, 2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ payload: 'Menu', voice: 'female', language: 'en-US', command_id: 'ivr-menu-log-1-standard' });
  });
  it('does not resend on a network failure, because Telnyx may already have the command', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(telnyx.speakIvr('control', 'Please hold', { kind: 'ivr-hold', callLogId: 'log', revision: 2 })).rejects.toThrow('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reads the webhook of a Voice API application and treats a SIP connection as no application', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '{"data":{"webhook_event_url":"https://api.suprah-app.com/api/webhooks/telnyx"}}' } as Response);
    await expect(telnyx.findVoiceApplication('conn')).resolves.toEqual({ webhookUrl: 'https://api.suprah-app.com/api/webhooks/telnyx' });
    expect(fetchMock.mock.calls[0][0]).toContain('/call_control_applications/conn');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"errors":[{"detail":"not found"}]}' } as Response);
    await expect(telnyx.findVoiceApplication('sip')).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '{"errors":[]}' } as Response);
    await expect(telnyx.findVoiceApplication('down')).rejects.toThrow();
  });
  it('tags the employee leg of a transfer too, so its answer and hang-up are recognized', async () => {
    await telnyx.transferToAgent('control', 'agent-sip', { kind: 'agent-leg', callLogId: 'log', userId: 'user', revision: 4 });
    const [url, request] = fetchMock.mock.calls[0];
    const body = JSON.parse(request.body);
    const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString());
    expect(url).toContain('/calls/control/actions/transfer');
    expect(body.to).toBe('sip:agent-sip@sip.telnyx.com');
    expect(decode(body.target_leg_client_state)).toEqual({ kind: 'agent-leg', callLogId: 'log', userId: 'user', revision: 4 });
    expect(body.client_state).toBe(body.target_leg_client_state);
  });
  it('records calls with a transcript, and a voicemail as one track with a beep and a 2-minute limit', async () => {
    await telnyx.recordingCommand('control', 'start', 'recording-start-1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ format: 'mp3', channels: 'dual', transcription: true, transcription_engine: 'A', transcription_language: 'en-US', play_beep: false });
    await telnyx.recordingCommand('control', 'start', 'voicemail-start-1', { channels: 'single', recording_track: 'inbound', play_beep: true, max_length: 120 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ channels: 'single', recording_track: 'inbound', play_beep: true, max_length: 120, transcription: true });
    await telnyx.recordingCommand('control', 'pause', 'recording-pause-1');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ command_id: 'recording-pause-1' });
  });
  it('deletes a saved transcript at the provider', async () => {
    await telnyx.deleteRecordingTranscription('transcript-1');
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain('/recording_transcriptions/transcript-1'); expect(request.method).toBe('DELETE');
  });
  it('keeps hold and terminal announcement commands distinct', async () => {
    await telnyx.speakIvr('control', 'Please hold', { kind: 'ivr-hold', callLogId: 'log', revision: 2 });
    await telnyx.speakIvr('control', 'Missed', { kind: 'ivr-missed', callLogId: 'log', revision: 3 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).command_id).toBe('ivr-speak-log-2-ivr-hold');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).command_id).toBe('ivr-speak-log-3-ivr-missed');
  });
});
