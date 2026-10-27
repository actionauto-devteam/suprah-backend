describe('Chrome extension rate limit keys', () => {
  const load = () => {
    let loaded: typeof import('../../src/middleware/rate-limit.middleware') | undefined;
    jest.isolateModules(() => {
      loaded = require('../../src/middleware/rate-limit.middleware');
    });
    return loaded!;
  };

  it('keys signed-in requests by employee, so coworkers on one office connection never share a limit', () => {
    const { extensionEmployeeKey } = load();
    const key = extensionEmployeeKey('ext-send');
    const officeIp = '203.0.113.7';
    expect(key({ ip: officeIp, crmUser: { _id: 'employee-a' } })).toBe('ext-send:employee-a');
    expect(key({ ip: officeIp, crmUser: { _id: 'employee-b' } })).toBe('ext-send:employee-b');
  });

  it('groups IPv6 addresses by /56 so rotating addresses cannot get around a limit, and keeps IPv4 as is', () => {
    const { extensionClientKey } = load();
    expect(extensionClientKey({ ip: '2001:db8:abcd:12ff:1111:2222:3333:4444' })).toBe(extensionClientKey({ ip: '2001:db8:abcd:1200:9999:8888:7777:6666' }));
    expect(extensionClientKey({ ip: '2001:db8:abcd:1300::1' })).not.toBe(extensionClientKey({ ip: '2001:db8:abcd:1200::1' }));
    expect(extensionClientKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('creates every extension limiter without the IPv6 key warning', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      load();
      const codes = spy.mock.calls.map((call) => (call[0] as { code?: string } | undefined)?.code).filter(Boolean);
      expect(codes).not.toContain('ERR_ERL_KEY_GEN_IPV6');
    } finally {
      spy.mockRestore();
    }
  });
});
