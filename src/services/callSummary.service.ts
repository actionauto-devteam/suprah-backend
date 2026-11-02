import {
  createGeminiClient,
  hasGeminiApiKey,
  createCompletionWithFallback as createCompletionWithFallbackShared,
  withTimeout,
} from '../utils/aiOutboundSafety';
import logger from '../utils/logger';

const gemini = createGeminiClient();

const GENERATION_MODEL = process.env.CALL_SUMMARY_GEMINI_MODEL || 'gemini-flash-lite-latest';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';
const GENERATION_TIMEOUT_MS = parseInt(process.env.CALL_SUMMARY_TIMEOUT_MS || '15000', 10);
const MAX_TRANSCRIPT_CHARS = 12000;

export interface CallSummary {
  points: string[];
  sentiment: string;
}

export function parseCallSummary(raw: string): CallSummary | null {
  const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const points = (Array.isArray(parsed?.summary) ? parsed.summary : [])
      .map((point: unknown) => String(point || '').replace(/\s+/g, ' ').trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 4);
    const sentiment = String(parsed?.sentiment || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return points.length ? { points, sentiment } : null;
  } catch {
    return null;
  }
}

export async function summarizeCallTranscript(transcript: string, voicemail: boolean): Promise<CallSummary | null> {
  const text = String(transcript || '').trim();
  if (!text || !hasGeminiApiKey()) return null;
  const systemPrompt = [
    `You summarize ${voicemail ? 'voicemails left for' : 'phone calls with'} a car dealership for its sales team.`,
    'Use only what is in the transcript. Do not guess names, prices or vehicles that are not said.',
    'Reply with JSON only, no other text: {"summary": ["..."], "sentiment": "..."}.',
    'summary: 1 to 4 short plain sentences about what was said, what the customer wants and any next step.',
    'sentiment: one short sentence about how the customer sounded. If there is no real customer speech, say so.',
  ].join('\n');
  try {
    const completion: any = await withTimeout(
      createCompletionWithFallbackShared(gemini, {
        model: GENERATION_MODEL,
        max_tokens: 400,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Transcript:\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}` },
        ],
      }, GEMINI_FALLBACK_MODEL, 'CallSummary'),
      GENERATION_TIMEOUT_MS,
      null,
    );
    if (!completion) {
      logger.warn('[CallSummary] Generation timed out');
      return null;
    }
    return parseCallSummary(completion?.choices?.[0]?.message?.content || '');
  } catch (err) {
    logger.error({ err }, '[CallSummary] Generation failed');
    return null;
  }
}
