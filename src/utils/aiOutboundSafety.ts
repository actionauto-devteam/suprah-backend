import OpenAI from 'openai';
import logger from './logger';
import { isDemoPhone } from './demoPhone';
import { isLocalMongoTarget } from './productionDbGuard.util';

const NO_KEY_PLACEHOLDER = 'disabled-no-key';

export function isLocalUiAcceptanceMode(): boolean {
  return (process.env.LOCAL_UI_ACCEPTANCE_MODE || '').trim().toLowerCase() === 'true';
}

export function isGeminiQaModeActive(): boolean {
  if (!isLocalUiAcceptanceMode()) return false;
  if ((process.env.LOCAL_GEMINI_QA_MODE || '').trim().toLowerCase() !== 'true') return false;
  if ((process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  if (!isLocalMongoTarget(process.env.MONGODB_URI)) return false;
  return true;
}

export function hasGeminiApiKey(phone?: string): boolean {
  if (isLocalUiAcceptanceMode()) {
    if (!isGeminiQaModeActive()) return false;
    if (!phone || !isDemoPhone(phone)) return false;
    return !!process.env.GEMINI_API_KEY;
  }
  return !!process.env.GEMINI_API_KEY;
}

export function createGeminiClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.GEMINI_API_KEY || NO_KEY_PLACEHOLDER,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  });
}

export async function createCompletionWithFallback(
  client: OpenAI,
  options: any,
  fallbackModel: string,
  logLabel: string,
): Promise<any> {
  try {
    return await client.chat.completions.create(options);
  } catch (err: any) {
    if (err?.status === 404 && options.model !== fallbackModel) {
      logger.warn(
        { model: options.model, fallback: fallbackModel },
        `[${logLabel}] Gemini model not found, retrying with fallback model`,
      );
      return client.chat.completions.create({ ...options, model: fallbackModel });
    }
    throw err;
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutValue: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(timeoutValue), ms)),
  ]);
}

const PROHIBITED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\s?\d/, reason: 'currency amount' },
  { pattern: /\bUSD\b/i, reason: 'currency amount' },
  { pattern: /\bprice[sd]?\b|\bpricing\b|\bMSRP\b/i, reason: 'price mention' },
  { pattern: /\d+\s?%\s?(off)?/i, reason: 'percent-off' },
  { pattern: /\bdiscount(s|ed)?\b|\bpromo(tion)?(al)?\b|\bincentive[s]?\b|\brebate[s]?\b|\bon sale\b|\bsale price\b|\bclearance\b|\bspecial offer\b/i, reason: 'discount/incentive language' },
  { pattern: /\bfinanc(e|ing)\b|\bloan[s]?\b|\blease[ds]?\b|\bAPR\b|\bdown payment\b|\bmonthly payment[s]?\b|\bcredit approv(al|ed)\b|\/\s?mo\b/i, reason: 'financing/payment language' },
  { pattern: /\btrade[\s-]?in\b/i, reason: 'trade-in mention' },
  { pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, reason: 'unexpected phone number' },
  { pattern: /https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io)\b/i, reason: 'unexpected link' },
  { pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, reason: 'unexpected email address' },
];

const ALWAYS_UNSAFE_AVAILABILITY = /\bguarantee(d)?\b|\bact fast\b|\bwon'?t last\b|\blimited (time|availability|stock)\b|\bhurry\b|\bfirst come\b/i;
const CONDITIONAL_AVAILABILITY_PHRASES = /\bstill available\b|\bin stock\b|\bavailable now\b/gi;
const AVAILABILITY_HEDGE_WORDS = /\b(if|whether|check|confirm(ing)?|verify|verifying|see|seeing|find out|let me|i'll|we'll|will|going to)\b/i;

export function hasGuaranteedAvailabilityLanguage(text: string): boolean {
  if (ALWAYS_UNSAFE_AVAILABILITY.test(text)) return true;
  for (const match of text.matchAll(CONDITIONAL_AVAILABILITY_PHRASES)) {
    const start = Math.max(0, (match.index ?? 0) - 30);
    const context = text.slice(start, match.index);
    if (!AVAILABILITY_HEDGE_WORDS.test(context)) return true;
  }
  return false;
}

export function validateOutboundMessage(text: string): { ok: boolean; reasons: string[] } {
  const reasons = PROHIBITED_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason);
  if (hasGuaranteedAvailabilityLanguage(text)) reasons.push('guaranteed-availability language');
  if (text.trim().length < 10) reasons.push('message too short or malformed');
  return { ok: reasons.length === 0, reasons: Array.from(new Set(reasons)) };
}

export function describeGenerationError(err: any, agentLabel: string): string {
  const status = err?.status || err?.code || err?.response?.status;
  const message = String(err?.message || err?.error?.message || '');

  if (status === 429 || message.includes('429')) {
    return `${agentLabel} is getting a lot of AI requests right now. This usually clears up in a few minutes.`;
  }
  if (/credit balance|plans? & billing|billing|upgrade|purchase credits/i.test(message)) {
    return `${agentLabel}'s AI credits are running low. An admin needs to add more before this can send.`;
  }
  if (status === 404) {
    return 'The configured AI model is unavailable. This should recover automatically on the next try.';
  }
  if (status === 503 || status === 502 || status === 500 || /no body/i.test(message)) {
    return `${agentLabel}'s AI service is temporarily unavailable. Try again in a few minutes.`;
  }
  return `${agentLabel} couldn't write a message right now. Try again in a moment.`;
}

export function stripDraftArtifacts(text: string): string {
  return String(text || '')
    .replace(/^```[a-z]*\n?|```$/gi, '')
    .replace(/^["""]+|["""]+$/g, '')
    .trim();
}

export async function classifySafety(
  client: OpenAI,
  text: string,
  opts: { model: string; fallbackModel: string; timeoutMs: number; systemPrompt: string; logLabel: string; phone?: string },
): Promise<'SAFE' | 'UNSAFE' | 'ERROR'> {
  if (!hasGeminiApiKey(opts.phone)) return 'ERROR';

  const call = createCompletionWithFallback(
    client,
    {
      model: opts.model,
      max_tokens: 10,
      temperature: 0,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: `Candidate message:\n"""\n${text}\n"""` },
      ],
    },
    opts.fallbackModel,
    opts.logLabel,
  )
    .then((completion: any) => {
      const raw = String(completion?.choices?.[0]?.message?.content || '').trim().toUpperCase();
      return raw === 'SAFE' ? 'SAFE' : 'UNSAFE';
    })
    .catch((err) => {
      logger.error({ err }, `[${opts.logLabel}] Classifier call failed`);
      return 'ERROR' as const;
    });

  return withTimeout(call, opts.timeoutMs, 'ERROR');
}
