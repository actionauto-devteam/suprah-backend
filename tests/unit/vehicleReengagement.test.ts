const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.VEHICLE_REENGAGEMENT_CLASSIFIER_TIMEOUT_MS = '50';

import {
  validateOutboundMessage,
  normalizeToken,
  matchesVehicle,
  classifyMessageSafety,
} from '../../src/services/vehicleReengagement.service';

// Full validateOutboundMessage / classifier cases now live in aiOutboundSafety.test.ts
// (the shared module both this service and aiAgent.service.ts delegate to).
// These are smoke tests confirming this service's thin wrappers still delegate correctly.
describe('validateOutboundMessage (delegates to the shared module)', () => {
  it('blocks a message containing a price', () => {
    expect(validateOutboundMessage('Great news, this is only $500 for you!').ok).toBe(false);
  });

  it('passes a benign re-engagement message', () => {
    expect(
      validateOutboundMessage(
        'Hi Alex, a 2022 Toyota Camry just arrived that matches what you were looking for. Come take a look!',
      ).ok,
    ).toBe(true);
  });
});

describe('normalizeToken', () => {
  it('lowercases, trims, and strips punctuation', () => {
    expect(normalizeToken('  Chevy-Silverado!! ')).toBe('chevy silverado');
  });

  it('handles undefined/empty input', () => {
    expect(normalizeToken(undefined)).toBe('');
    expect(normalizeToken('')).toBe('');
  });
});

describe('matchesVehicle', () => {
  const vehicle = { year: 2022, make: 'Toyota', modelName: 'Camry SE' } as any;

  it('matches exact year/make/model', () => {
    expect(matchesVehicle({ year: '2022', make: 'Toyota', model: 'Camry SE' }, vehicle)).toBe(true);
  });

  it('matches a trim-variant substring both directions', () => {
    expect(matchesVehicle({ year: '2022', make: 'Toyota', model: 'Camry' }, vehicle)).toBe(true);
  });

  it('rejects a year mismatch', () => {
    expect(matchesVehicle({ year: '2021', make: 'Toyota', model: 'Camry' }, vehicle)).toBe(false);
  });

  it('rejects a make mismatch', () => {
    expect(matchesVehicle({ year: '2022', make: 'Honda', model: 'Camry' }, vehicle)).toBe(false);
  });

  it('requires an exact match for short model strings instead of a substring hit', () => {
    const shortModelVehicle = { year: 2022, make: 'Kia', modelName: 'K5' } as any;
    expect(matchesVehicle({ year: '2022', make: 'Kia', model: 'K' }, shortModelVehicle)).toBe(false);
    expect(matchesVehicle({ year: '2022', make: 'Kia', model: 'K5' }, shortModelVehicle)).toBe(true);
  });

  it('rejects when the lead vehicle year is not a valid number', () => {
    expect(matchesVehicle({ year: 'unknown', make: 'Toyota', model: 'Camry' }, vehicle)).toBe(false);
  });
});

describe('classifyMessageSafety (delegates to the shared classifier)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns SAFE only on an exact "SAFE" response', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    await expect(classifyMessageSafety('hello')).resolves.toBe('SAFE');
  });

  it('treats a literal "UNSAFE" response as unsafe, not a SAFE substring match', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'UNSAFE' } }] });
    await expect(classifyMessageSafety('hello')).resolves.toBe('UNSAFE');
  });

  it('resolves to ERROR on timeout rather than hanging', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(classifyMessageSafety('hello')).resolves.toBe('ERROR');
  });
});
