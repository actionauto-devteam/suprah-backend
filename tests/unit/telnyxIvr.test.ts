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
  it('keeps hold and terminal announcement commands distinct', async () => {
    await telnyx.speakIvr('control', 'Please hold', { kind: 'ivr-hold', callLogId: 'log', revision: 2 });
    await telnyx.speakIvr('control', 'Missed', { kind: 'ivr-missed', callLogId: 'log', revision: 3 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).command_id).toBe('ivr-speak-log-2-ivr-hold');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).command_id).toBe('ivr-speak-log-3-ivr-missed');
  });
});
