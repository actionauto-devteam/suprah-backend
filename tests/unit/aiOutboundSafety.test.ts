const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';

import {
  validateOutboundMessage,
  describeGenerationError,
  createGeminiClient,
  classifySafety,
  hasGeminiApiKey,
} from '../../src/utils/aiOutboundSafety';

describe('validateOutboundMessage', () => {
  const shouldBlock: Array<[string, string]> = [
    ['Great news, this is only $500 for you!', 'price'],
    ['We can do 20% off this week', 'percent-off'],
    ['Ask about our special discount today', 'discount'],
    ['Low monthly payment financing available', 'financing'],
    ['We will value your trade-in highly', 'trade-in'],
    ['This one is still available, hurry in!', 'guaranteed-availability'],
    ['Call us at 801-244-7049 today', 'phone number'],
    ['Check it out at https://actionautoutah.com', 'link'],
    ['Email us at sales@actionautoutah.com', 'email'],
    ['hi', 'too short'],
  ];

  it.each(shouldBlock)('blocks: %s (%s)', (text) => {
    const result = validateOutboundMessage(text);
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  const shouldPass = [
    'Hi Alex, a 2022 Toyota Camry just arrived that matches what you were looking for. Come take a look!',
    'Hi Jordan, we just got in a vehicle similar to one you asked about before. Stop by anytime.',
  ];

  it.each(shouldPass)('passes: %s', (text) => {
    const result = validateOutboundMessage(text);
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });
});

describe('describeGenerationError', () => {
  it('maps a 429 status to a rate-limit message naming the agent', () => {
    expect(describeGenerationError({ status: 429 }, 'Alex')).toContain('Alex');
  });

  it('maps a credit/billing message to a credits-low message', () => {
    expect(describeGenerationError({ message: 'credit balance too low' }, 'Autrix')).toMatch(/credits/i);
  });

  it('maps a 503 to a temporarily-unavailable message', () => {
    expect(describeGenerationError({ status: 503 }, 'Alex')).toMatch(/unavailable/i);
  });

  it('falls back to a generic message for an unrecognized error', () => {
    expect(describeGenerationError({}, 'Alex')).toContain('Alex');
  });
});

describe('hasGeminiApiKey', () => {
  it('reflects whether GEMINI_API_KEY is set', () => {
    expect(hasGeminiApiKey()).toBe(true);
  });
});

describe('classifySafety', () => {
  const client = createGeminiClient();
  const opts = {
    model: 'gemini-flash-lite-latest',
    fallbackModel: 'gemini-flash-lite-latest',
    timeoutMs: 50,
    systemPrompt: 'Respond SAFE or UNSAFE.',
    logLabel: 'Test',
  };

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns SAFE only on an exact "SAFE" response', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    await expect(classifySafety(client, 'hello', opts)).resolves.toBe('SAFE');
  });

  it('treats a literal "UNSAFE" response as unsafe, not a SAFE substring match', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'UNSAFE' } }] });
    await expect(classifySafety(client, 'hello', opts)).resolves.toBe('UNSAFE');
  });

  it('treats an empty response as unsafe', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
    await expect(classifySafety(client, 'hello', opts)).resolves.toBe('UNSAFE');
  });

  it('treats a rambling non-exact response as unsafe', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'I think this is safe' } }] });
    await expect(classifySafety(client, 'hello', opts)).resolves.toBe('UNSAFE');
  });

  it('resolves to ERROR, not a rejection, when the provider call throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('network error'));
    await expect(classifySafety(client, 'hello', opts)).resolves.toBe('ERROR');
  });

  it('resolves to ERROR on timeout rather than hanging', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(classifySafety(client, 'hello', opts)).resolves.toBe('ERROR');
  });
});
