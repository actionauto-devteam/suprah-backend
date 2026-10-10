import { recordingCommand, recordingDisclosure, findRecordings } from '../../src/services/telnyx.service';
describe('Telnyx recording commands without network access', () => {
  const original = global.fetch;
  afterEach(() => { global.fetch = original; });
  function respond(value: unknown, ok = true) { global.fetch = jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(value) }); }
  it.each(['start', 'pause', 'resume', 'stop'] as const)('uses provider %s command and command id', async action => {
    respond({ data: { result: 'ok' } }); await recordingCommand('control', action, 'unique-command');
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0]; expect(url).toContain(`/actions/record_${action}`); expect(JSON.parse(options.body).command_id).toBe('unique-command');
    if (action === 'start') expect(JSON.parse(options.body)).toMatchObject({ channels: 'dual', recording_track: 'both', format: 'mp3' });
    expect(JSON.parse(options.body).client_state).toBeUndefined();
  });
  it.each([null, {}, { data: {} }, { data: { result: 'pending' } }])('does not accept malformed acknowledgement %j', async value => { respond(value); await expect(recordingCommand('c', 'pause', 'id')).rejects.toThrow('acknowledged'); });
  it('provider failure is not successful pause', async () => { respond({ errors: [] }, false); await expect(recordingCommand('c', 'pause', 'id')).rejects.toThrow(); });
  it('disclosure preserves original call correlation plus recording tag', async () => { respond({ data: { result: 'ok' } }); await recordingDisclosure('c', 'Notice', 'en-US', 'id', 'merged-state'); expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({ target_legs: 'both', client_state: 'merged-state' }); });
  it('rejects malformed provider listing', async () => { respond({ data: {} }); await expect(findRecordings('session')).rejects.toThrow('malformed'); });
});
