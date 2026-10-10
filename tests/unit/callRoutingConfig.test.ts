import { parseRoutingConfig, routingPhone } from '../../src/services/callRoutingConfig.service';

const id = '507f1f77bcf86cd799439011';
function config() {
  return {
    enabled: true, name: 'Test', inboundNumber: '+18015550100', mainNumber: '+18017666137',
    greeting: 'Press 1 for our location', ringTimeoutSeconds: 35, retryCount: 1,
    receptionGroupId: id, allOrgFallback: false,
    options: [{ digit: '1', label: 'Location', type: 'location', groupId: id, leadLocation: 'Orem', language: '', externalDestination: '' }],
  };
}

describe('IVR configuration validation', () => {
  it('normalizes phone formats and preserves approved defaults', () => {
    expect(routingPhone('(801) 766-6137')).toBe('+18017666137');
    expect(parseRoutingConfig(config())).toMatchObject({ retryCount: 1, allOrgFallback: false });
  });
  it.each(['+18017666137', '+18015550100', '+18015550999'])('rejects loop destination %s', destination => {
    const input = config(); input.options[0].externalDestination = destination;
    expect(() => parseRoutingConfig(input, '+18015550999')).toThrow('External destination');
  });
  it('accepts a pending external Service destination without enabling external transfer', () => {
    const input = config(); input.options[0].externalDestination = '(801) 875-2782';
    expect(parseRoutingConfig(input).options[0].externalDestination).toBe('+18018752782');
    expect(() => parseRoutingConfig({ ...input, externalTransferEnabled: true })).toThrow();
  });
  it('rejects duplicate digits, malformed numbers and invalid timeout/retry values', () => {
    const input = config();
    expect(() => parseRoutingConfig({ ...input, options: [...input.options, input.options[0]] })).toThrow('unique');
    expect(() => parseRoutingConfig({ ...input, inboundNumber: 'invalid' })).toThrow();
    expect(() => parseRoutingConfig({ ...input, ringTimeoutSeconds: 0 })).toThrow();
    expect(() => parseRoutingConfig({ ...input, retryCount: 99 })).toThrow();
  });
  it('only location options may populate Lead.location', () => {
    const input = config(); input.options[0].type = 'department';
    expect(() => parseRoutingConfig(input)).toThrow('Only location');
  });
  it('requires configured groups when enabled and allows disabled drafts', () => {
    const input = { ...config(), receptionGroupId: null };
    expect(() => parseRoutingConfig(input)).toThrow('require a Lead Group');
    expect(parseRoutingConfig({ ...input, enabled: false }).enabled).toBe(false);
  });
});
