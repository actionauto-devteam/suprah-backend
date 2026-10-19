import { sendSms } from '../../src/services/telnyx.service';

describe('Demo Lab numbers never reach the Telnyx network', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns a simulated id for a fictional 555-01xx number without any network call', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const result = await sendSms('+18015550142', 'Hi from Alex');
    expect(result.id).toMatch(/^demo-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still uses the network for a real number, proving the check is what blocks demo numbers', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ data: { id: 'real-1', to: [] } }) });
    global.fetch = fetchSpy as any;
    await sendSms('+13853365062', 'Hi');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
