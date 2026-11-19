/**
 * Deal Builder AI — reads documents and writes the F&I summary.
 * It never does math (see calc.ts) and never sees the SSN.
 *
 * Provider is picked from env:
 *   DEAL_AI_PROVIDER = anthropic | openai | none   (default: whichever key is set)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY
 *   DEAL_AI_MODEL    (optional override)
 * Use a provider account with zero data retention for production.
 */
import { getDealFileBuffer } from './storage';

type Provider = 'anthropic' | 'openai' | 'none';

export function aiProvider(): Provider {
  const forced = (process.env.DEAL_AI_PROVIDER || '').toLowerCase();
  if (forced === 'none') return 'none';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (forced === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

const ANTHROPIC_MODEL = () => process.env.DEAL_AI_MODEL || 'claude-sonnet-5-5';
const OPENAI_MODEL = () => process.env.DEAL_AI_MODEL || 'gpt-4.1-mini';
const TIMEOUT_MS = 60_000;

async function callAnthropic(system: string, content: any[], maxTokens = 1500): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL(), max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

async function callOpenAI(system: string, content: any[], maxTokens = 1500): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL(),
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseJson(text: string): any | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ───────────────────────── Extraction ───────────────────────── */

const EXTRACT_SYSTEM = `You read auto dealership deal documents (four square worksheets, credit applications, driver licenses, pay stubs) and return ONLY a JSON object.
Rules:
- Never output Social Security numbers, driver license numbers, account numbers or dates of birth.
- Use numbers (no $ or commas) for money and counts. Monthly amounts must be monthly; convert annual salary ÷ 12 and say so in notes.
- Omit any field you cannot read with confidence. Do not guess.
Shape:
{"customer":{"firstName":"","lastName":"","phone":"","email":"","address":{"street":"","city":"","state":"","zip":""}},
 "vehicle":{"vin":"","year":0,"make":"","model":"","trim":"","mileage":0,"price":0},
 "tradeIn":{"vin":"","year":0,"make":"","model":"","mileage":0,"allowance":0,"payoff":0,"lienholder":""},
 "fourSquare":{"salePrice":0,"downPayment":0,"desiredPayment":0,"desiredTerm":0,"docFee":0},
 "creditApp":{"employer":"","jobTitle":"","employmentMonths":0,"grossMonthlyIncome":0,"otherMonthlyIncome":0,"housingStatus":"own|rent|family|other","housingPayment":0,"residenceMonths":0},
 "notes":["short observations, e.g. income on pay stub differs from application"]}`;

const EXTRACTABLE = ['four_square', 'credit_app', 'drivers_license', 'proof_income', 'proof_residence', 'trade_title'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface ExtractionResult {
  data: any;
  provider: Provider;
  documentsRead: number;
}

export async function extractFromDocuments(documents: { kind: string; key: string; mime: string; name: string; size: number }[]): Promise<ExtractionResult | null> {
  const provider = aiProvider();
  if (provider === 'none') return null;

  const docs = documents
    .filter((d) => EXTRACTABLE.includes(d.kind))
    .filter((d) => d.mime === 'application/pdf' ? provider === 'anthropic' : IMAGE_MIMES.includes(d.mime))
    .filter((d) => d.size <= 10 * 1024 * 1024)
    .slice(0, 6);
  if (!docs.length) return null;

  const blocks: any[] = [];
  let total = 0;
  for (const d of docs) {
    try {
      const buf = await getDealFileBuffer(d.key);
      total += buf.length;
      if (total > 24 * 1024 * 1024) break;
      const b64 = buf.toString('base64');
      if (provider === 'anthropic') {
        blocks.push({ type: 'text', text: `Document type: ${d.kind.replace(/_/g, ' ')} (${d.name})` });
        blocks.push(
          d.mime === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
            : { type: 'image', source: { type: 'base64', media_type: d.mime, data: b64 } },
        );
      } else {
        blocks.push({ type: 'text', text: `Document type: ${d.kind.replace(/_/g, ' ')} (${d.name})` });
        blocks.push({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${b64}` } });
      }
    } catch (err) {
      console.error('[deal-desk] could not load document for AI', d.name, err);
    }
  }
  const documentsRead = blocks.filter((b) => b.type !== 'text').length;
  if (!documentsRead) return null;
  blocks.push({ type: 'text', text: 'Extract the deal fields from these documents. Return only the JSON object.' });

  const text = provider === 'anthropic' ? await callAnthropic(EXTRACT_SYSTEM, blocks, 2000) : await callOpenAI(EXTRACT_SYSTEM, blocks, 2000);
  const data = parseJson(text);
  if (!data) return null;
  stripSensitive(data);
  return { data, provider, documentsRead };
}

function stripSensitive(obj: any) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (/ssn|social|license(number)?|dlnumber|dob|birth|account/i.test(k)) delete obj[k];
    else stripSensitive(obj[k]);
  }
}

/**
 * Merge AI-extracted fields into the deal: only fills EMPTY fields (a
 * person's entry always wins) and reports material conflicts as flags.
 */
export function mergeExtraction(deal: any, data: any): { set: Record<string, unknown>; conflicts: string[]; filled: string[] } {
  const set: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const filled: string[] = [];
  const sections = ['customer', 'vehicle', 'tradeIn', 'fourSquare', 'creditApp'];
  const numericTolerance: Record<string, number> = {
    'creditApp.grossMonthlyIncome': 0.1,
    'fourSquare.salePrice': 0.02,
    'vehicle.price': 0.02,
    'fourSquare.downPayment': 0.05,
    'tradeIn.payoff': 0.05,
    'tradeIn.allowance': 0.05,
  };
  const walk = (prefix: string, src: any, current: any) => {
    for (const [k, v] of Object.entries(src || {})) {
      const path = `${prefix}.${k}`;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(path, v, current?.[k]);
        continue;
      }
      if (v === '' || v === 0 || v == null) continue;
      const cur = current?.[k];
      if (cur === undefined || cur === null || cur === '') {
        set[path] = v;
        filled.push(path);
      } else if (typeof v === 'number' && typeof cur === 'number' && numericTolerance[path] != null) {
        const diff = Math.abs(v - cur) / Math.max(1, Math.abs(cur));
        if (diff > numericTolerance[path]) conflicts.push(`${labelFor(path)}: entered ${fmt(cur)}, documents show ${fmt(v)}`);
      } else if (typeof v === 'string' && typeof cur === 'string' && path === 'vehicle.vin' && v.toUpperCase() !== cur.toUpperCase()) {
        conflicts.push(`VIN on documents (${v}) doesn't match the deal (${cur})`);
      }
    }
  };
  for (const s of sections) walk(s, data?.[s], deal?.[s]);
  if (set['tradeIn.vin'] || set['tradeIn.allowance']) set['tradeIn.present'] = true;
  return { set, conflicts, filled };
}

const fmt = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : String(v));
function labelFor(path: string) {
  const map: Record<string, string> = {
    'creditApp.grossMonthlyIncome': 'Monthly income',
    'fourSquare.salePrice': 'Sale price',
    'vehicle.price': 'Vehicle price',
    'fourSquare.downPayment': 'Down payment',
    'tradeIn.payoff': 'Trade payoff',
    'tradeIn.allowance': 'Trade allowance',
  };
  return map[path] || path;
}

/* ───────────────────────── Summary ───────────────────────── */

const SUMMARY_SYSTEM = `You are the Deal Builder assistant for a car dealership's Finance Managers.
Write a short deal summary (3–5 sentences, plain English, no markdown headings) that a Finance Manager can read in 15 seconds.
Cover: the customer's situation, the structure (amount financed, LTV, DTI, PTI), the best lender options and why, and anything that needs attention.
Use only the facts given. Do not invent numbers. Refer to the customer by first name only. Never mention SSN.`;

export function templateSummary(input: SummaryInput): string {
  const a = input.analysis;
  const best = input.lenders.filter((l) => l.fit !== 'fail').slice(0, 2);
  const money = (v?: number) => (v != null ? `$${Math.round(v).toLocaleString()}` : '—');
  const pct = (v?: number) => (v != null ? `${v}%` : 'unknown');
  const parts = [
    `${input.firstName || 'The customer'} is buying the ${input.vehicle || 'vehicle'} with ${money(a.amountFinanced)} financed (LTV ${pct(a.ltv)}, DTI ${pct(a.dti)}, PTI ${pct(a.pti)}).`,
    best.length
      ? `Best fit: ${best.map((l) => `${l.name} at ~${l.rate}% for ${l.term} mo (${money(l.payment)}/mo)`).join('; ')}.`
      : 'No lender in the matrix fits as structured — consider more down payment or a different vehicle.',
  ];
  const attention = a.flags.filter((f) => f.level !== 'info').map((f) => f.message);
  if (attention.length) parts.push(`Needs attention: ${attention.slice(0, 3).join('; ')}.`);
  return parts.join(' ');
}

export interface SummaryInput {
  firstName?: string;
  vehicle?: string;
  analysis: { amountFinanced: number; ltv?: number; dti?: number; pti?: number; estPayment?: number; estRate?: number; estTerm?: number; flags: { level: string; message: string }[] };
  lenders: { name: string; fit: string; rate?: number; term?: number; payment?: number; reasons: string[] }[];
  employmentMonths?: number;
  residenceMonths?: number;
  housingStatus?: string;
  tradeIn?: boolean;
  downPayment?: number;
  desiredPayment?: number;
}

export async function summarizeDeal(input: SummaryInput): Promise<{ text: string; provider: Provider }> {
  const provider = aiProvider();
  if (provider === 'none') return { text: templateSummary(input), provider };
  try {
    const facts = JSON.stringify(input, null, 1);
    const content = [{ type: 'text', text: `Deal facts (JSON):\n${facts}\n\nWrite the summary.` }];
    const text = provider === 'anthropic' ? await callAnthropic(SUMMARY_SYSTEM, content, 400) : await callOpenAI(SUMMARY_SYSTEM, content, 400);
    return { text: text.trim() || templateSummary(input), provider };
  } catch (err) {
    console.error('[deal-desk] AI summary failed, using template', err);
    return { text: templateSummary(input), provider: 'none' };
  }
}
