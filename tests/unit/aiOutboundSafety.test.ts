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
  isLocalUiAcceptanceMode,
  isGeminiQaModeActive,
} from '../../src/utils/aiOutboundSafety';

const DEMO_PHONE = '+18015550142';
const REAL_LOOKING_PHONE = '+18015551234';

const ORIGINAL_ENV = {
  LOCAL_UI_ACCEPTANCE_MODE: process.env.LOCAL_UI_ACCEPTANCE_MODE,
  LOCAL_GEMINI_QA_MODE: process.env.LOCAL_GEMINI_QA_MODE,
  NODE_ENV: process.env.NODE_ENV,
  MONGODB_URI: process.env.MONGODB_URI,
};

function restoreGeminiQaEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete (process.env as any)[key];
    else (process.env as any)[key] = value;
  }
}

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
    "Thanks for asking about the Audi! I'll check with the team to confirm if it is still available and get back to you.",
    'Let me verify whether it is still available before I promise anything.',
  ];

  it.each(shouldPass)('passes: %s', (text) => {
    const result = validateOutboundMessage(text);
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('still blocks an unhedged availability claim even without urgency language', () => {
    const result = validateOutboundMessage('Yes, it is still available for you right away.');
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('guaranteed-availability language');
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
  afterEach(() => {
    restoreGeminiQaEnv();
  });

  it('reflects whether GEMINI_API_KEY is set', () => {
    expect(hasGeminiApiKey()).toBe(true);
  });

  it('returns false when LOCAL_UI_ACCEPTANCE_MODE is true, even with a real key present', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    expect(hasGeminiApiKey()).toBe(false);
  });

  it('is unaffected when LOCAL_UI_ACCEPTANCE_MODE is absent', () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    expect(hasGeminiApiKey()).toBe(true);
  });

  it('ignores the phone argument entirely outside LOCAL_UI_ACCEPTANCE_MODE (no behavior change for any existing caller)', () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    expect(hasGeminiApiKey(DEMO_PHONE)).toBe(true);
    expect(hasGeminiApiKey(REAL_LOOKING_PHONE)).toBe(true);
    expect(hasGeminiApiKey(undefined)).toBe(true);
  });

  it('stays false under LOCAL_UI_ACCEPTANCE_MODE even with a demo phone when LOCAL_GEMINI_QA_MODE is not set (matches today\'s behavior for vehicleReengagement/leadAiSummary/coaching, which never pass a phone)', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    expect(hasGeminiApiKey(DEMO_PHONE)).toBe(false);
    expect(hasGeminiApiKey()).toBe(false);
  });

  it('with the QA exception active, stays false when no phone is given', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    expect(hasGeminiApiKey()).toBe(false);
    expect(hasGeminiApiKey(undefined)).toBe(false);
  });

  it('with the QA exception active, stays false for a real-looking (non-demo-pattern) phone', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    expect(hasGeminiApiKey(REAL_LOOKING_PHONE)).toBe(false);
  });

  it('with the QA exception active and every condition verified, returns true for a genuine demo-pattern phone', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    expect(hasGeminiApiKey(DEMO_PHONE)).toBe(true);
  });

  it('still fails closed when the QA exception is otherwise active but MONGODB_URI cannot be verified as local', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb+srv://user:pass@supra-ai-prod.mongodb.net/test';
    expect(hasGeminiApiKey(DEMO_PHONE)).toBe(false);
  });

  it('still fails closed when NODE_ENV is production, even if every other condition looks satisfied', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    process.env.NODE_ENV = 'production';
    expect(hasGeminiApiKey(DEMO_PHONE)).toBe(false);
  });
});

describe('isGeminiQaModeActive', () => {
  afterEach(() => {
    restoreGeminiQaEnv();
  });

  it('is false when LOCAL_UI_ACCEPTANCE_MODE is not true, regardless of the QA flag', () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    expect(isGeminiQaModeActive()).toBe(false);
  });

  it('is false when LOCAL_GEMINI_QA_MODE is unset, empty, or anything other than the literal string "true"', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    delete process.env.LOCAL_GEMINI_QA_MODE;
    expect(isGeminiQaModeActive()).toBe(false);
    process.env.LOCAL_GEMINI_QA_MODE = '1';
    expect(isGeminiQaModeActive()).toBe(false);
    process.env.LOCAL_GEMINI_QA_MODE = 'yes';
    expect(isGeminiQaModeActive()).toBe(false);
  });

  it('is false when NODE_ENV is production', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    process.env.NODE_ENV = 'production';
    expect(isGeminiQaModeActive()).toBe(false);
  });

  it('is false when MONGODB_URI cannot be verified as a local target (unset, malformed, or a non-local/production host)', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    delete process.env.MONGODB_URI;
    expect(isGeminiQaModeActive()).toBe(false);
    process.env.MONGODB_URI = 'not-a-connection-string';
    expect(isGeminiQaModeActive()).toBe(false);
    process.env.MONGODB_URI = 'mongodb+srv://user:pass@supra-ai-prod.mongodb.net/test';
    expect(isGeminiQaModeActive()).toBe(false);
  });

  it('is true only when every condition is simultaneously verified', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    delete process.env.NODE_ENV;
    expect(isGeminiQaModeActive()).toBe(true);
  });
});

describe('isLocalUiAcceptanceMode', () => {
  afterEach(() => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
  });

  it('is false when unset', () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    expect(isLocalUiAcceptanceMode()).toBe(false);
  });

  it('is false for any value other than the literal string "true"', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'TRUE_ISH';
    expect(isLocalUiAcceptanceMode()).toBe(false);
    process.env.LOCAL_UI_ACCEPTANCE_MODE = '1';
    expect(isLocalUiAcceptanceMode()).toBe(false);
  });

  it('is true for "true", case-insensitively and with surrounding whitespace', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = ' True ';
    expect(isLocalUiAcceptanceMode()).toBe(true);
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'TRUE';
    expect(isLocalUiAcceptanceMode()).toBe(true);
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

  describe('under LOCAL_UI_ACCEPTANCE_MODE + the Gemini QA exception', () => {
    afterEach(() => {
      restoreGeminiQaEnv();
      mockCreate.mockReset();
    });

    it('resolves to ERROR without ever calling the provider when opts.phone is omitted', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      process.env.LOCAL_GEMINI_QA_MODE = 'true';
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
      await expect(classifySafety(client, 'hello', opts)).resolves.toBe('ERROR');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('resolves to ERROR without ever calling the provider for a real-looking, non-demo phone', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      process.env.LOCAL_GEMINI_QA_MODE = 'true';
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
      await expect(classifySafety(client, 'hello', { ...opts, phone: REAL_LOOKING_PHONE })).resolves.toBe('ERROR');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('does call the provider when every QA-mode condition is verified and the phone is a genuine demo number', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      process.env.LOCAL_GEMINI_QA_MODE = 'true';
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
      mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
      await expect(classifySafety(client, 'hello', { ...opts, phone: DEMO_PHONE })).resolves.toBe('SAFE');
      expect(mockCreate).toHaveBeenCalled();
    });
  });
});

describe('Gemini QA exception — cannot reach unrelated external services', () => {
  afterEach(() => {
    restoreGeminiQaEnv();
  });

  it('leaves isLocalUiAcceptanceMode() (the single flag Telnyx/email/Gmail/Calendar/call-recording storage all check) fully in force, regardless of the new QA flag', () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    expect(isLocalUiAcceptanceMode()).toBe(true);
  });

  it('the QA flag alone, without LOCAL_UI_ACCEPTANCE_MODE, grants no exception at all', () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    expect(hasGeminiApiKey(DEMO_PHONE)).toBe(true);
  });
});

describe('Gemini QA exception — scope guard (static source check)', () => {
  const fs = require('fs');
  const path = require('path');

  it('vehicleReengagement.service.ts still calls hasGeminiApiKey()/classifySafety() with no phone argument, so it stays blocked under the QA exception exactly as before', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/services/vehicleReengagement.service.ts'),
      'utf8',
    );
    expect(source).toMatch(/hasGeminiApiKey\(\)/);
    expect(source).not.toMatch(/hasGeminiApiKey\([^)]+\)/);
  });

  it('leadAiSummary.service.ts still calls hasGeminiApiKey() with no phone argument, so it stays blocked under the QA exception exactly as before', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/services/leadAiSummary.service.ts'),
      'utf8',
    );
    expect(source).toMatch(/hasGeminiApiKey\(\)/);
    expect(source).not.toMatch(/hasGeminiApiKey\([^)]+\)/);
  });

  it('supraLeo.controller.ts (Autrix, Anthropic/Groq-capable) never references the Gemini QA exception or hasGeminiApiKey at all — it stays gated purely by its own unmodified isLocalUiAcceptanceMode() checks', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/controllers/supraLeo.controller.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/hasGeminiApiKey|isGeminiQaModeActive|LOCAL_GEMINI_QA_MODE/);
    expect(source).toMatch(/isLocalUiAcceptanceMode/);
  });

  it('telnyx.service.ts never references the Gemini QA exception — Telnyx stays gated purely by its own unmodified isLocalUiAcceptanceMode() check', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/services/telnyx.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/hasGeminiApiKey|isGeminiQaModeActive|LOCAL_GEMINI_QA_MODE/);
    expect(source).toMatch(/isLocalUiAcceptanceMode/);
  });

  it('email.service.ts, orgGmail.service.ts, and googleCalendar.service.ts never reference the Gemini QA exception — all three stay gated purely by their own unmodified isLocalUiAcceptanceMode() checks', () => {
    for (const file of ['../../src/services/email.service.ts', '../../src/services/orgGmail.service.ts', '../../src/services/googleCalendar.service.ts']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/hasGeminiApiKey|isGeminiQaModeActive|LOCAL_GEMINI_QA_MODE/);
      expect(source).toMatch(/isLocalUiAcceptanceMode/);
    }
  });
});
