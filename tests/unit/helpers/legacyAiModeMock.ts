export function legacyAiModeMock(resolveSettings: (orgId: any) => Promise<any>) {
  const actual = jest.requireActual('../../../src/services/aiOperatingMode.service');
  const { AiReplySuppressedError } = jest.requireActual('../../../src/utils/aiReplySuppressed');
  const modeFor = async (orgId: any) => {
    const settings = await resolveSettings(orgId);
    return settings?.enabled ? 'live' : 'off';
  };
  return {
    ...actual,
    resolveAiChannelMode: jest.fn(async (orgId: any) => ({ mode: await modeFor(orgId), source: 'legacy' })),
    decideAiDelivery: jest.fn(async (input: any) => {
      const mode = await modeFor(input.organizationId);
      return mode === 'live'
        ? { action: 'send', mode, source: 'legacy' }
        : { action: 'skip', mode, source: 'legacy', reason: actual.AI_NOT_LIVE_REASON };
    }),
    assertAiDispatchAllowed: jest.fn(async (input: any) => {
      const mode = await modeFor(input.organizationId);
      if (mode !== 'live') throw new AiReplySuppressedError();
      return { action: 'send', mode, source: 'legacy' };
    }),
    recordAiUsage: jest.fn(async () => undefined),
  };
}
