import { Request, Response } from 'express';
import OpenAI from 'openai';
import crypto from 'crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Vehicle from '../models/Vehicle.model';
import ShopAssistantChat, { IShopPreferences } from '../models/ShopAssistantChat.model';
import membershipService from '../services/membership.service';
import logger from '../utils/logger';

// ─── Gemini client (same pattern as supraLeo.controller.ts) ───────────────────

const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const emptyPreferences = (): IShopPreferences => ({
  vehicleTypes: [],
  budgetMin: null,
  budgetMax: null,
  brands: [],
  fuelTypes: [],
  passengers: null,
  usage: [],
});

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function getSessionId(req: Request): string {
  const fromHeader = req.header('x-shop-session-id');
  const fromBody = req.body?.sessionId;
  const fromQuery = req.query?.sessionId as string | undefined;
  return (fromHeader || fromBody || fromQuery || crypto.randomUUID()) as string;
}

// ─── Preference extraction (AI call #1) ────────────────────────────────────────

async function extractPreferences(
  history: { role: 'user' | 'assistant'; content: string }[],
  currentPrefs: IShopPreferences,
  latestMessage: string,
  inventoryBlurb: string
): Promise<{ preferences: IShopPreferences; clarifyingQuestion: string | null; suggestions: string[] }> {
  const systemPrompt = `You are the preference-extraction brain behind "Suprah Autrix", a friendly vehicle shopping assistant for a multi-dealer marketplace.

Your job: read the conversation and the latest user message, then output the user's UPDATED shopping preferences as strict JSON. Always carry forward previously known preferences unless the user clearly contradicts them — never drop known info just because it wasn't repeated.

Known inventory snapshot (for realism only, do not invent numbers beyond this):
${inventoryBlurb}

Current known preferences:
${JSON.stringify(currentPrefs)}

Respond with ONLY this JSON shape, no markdown fences, no commentary:
{
  "preferences": {
    "vehicleTypes": string[],      // e.g. "SUV", "sedan", "truck", "electric", "coupe"
    "budgetMin": number | null,
    "budgetMax": number | null,
    "brands": string[],
    "fuelTypes": string[],         // e.g. "Gasoline", "Hybrid", "Electric", "Diesel"
    "passengers": number | null,
    "usage": string[]              // e.g. "commuting", "family", "towing", "off-road"
  },
  "clarifyingQuestion": string | null,  // set ONLY if you don't yet have enough info (no vehicleType/budget/brand at all) to search; otherwise null
  "suggestions": string[]         // 3 short tappable follow-up phrases the user might send next, phrased as if the USER is saying them
}`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history.slice(-8),
    { role: 'user' as const, content: latestMessage },
  ];

  const response = await gemini.chat.completions.create({
    model: GEMINI_MODEL,
    max_tokens: 500,
    messages,
    stream: false,
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    return {
      preferences: {
        vehicleTypes: Array.isArray(parsed.preferences?.vehicleTypes) ? parsed.preferences.vehicleTypes : currentPrefs.vehicleTypes,
        budgetMin: parsed.preferences?.budgetMin ?? currentPrefs.budgetMin ?? null,
        budgetMax: parsed.preferences?.budgetMax ?? currentPrefs.budgetMax ?? null,
        brands: Array.isArray(parsed.preferences?.brands) ? parsed.preferences.brands : currentPrefs.brands,
        fuelTypes: Array.isArray(parsed.preferences?.fuelTypes) ? parsed.preferences.fuelTypes : currentPrefs.fuelTypes,
        passengers: parsed.preferences?.passengers ?? currentPrefs.passengers ?? null,
        usage: Array.isArray(parsed.preferences?.usage) ? parsed.preferences.usage : currentPrefs.usage,
      },
      clarifyingQuestion: parsed.clarifyingQuestion ?? null,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 4) : [],
    };
  } catch (err) {
    logger.warn({ err, raw }, '[shopAssistant] Failed to parse preference extraction JSON');
    return { preferences: currentPrefs, clarifyingQuestion: null, suggestions: [] };
  }
}

// ─── Candidate scoring (deterministic — no AI, no hallucinated numbers) ───────

function scoreVehicle(v: any, prefs: IShopPreferences) {
  let score = 55;
  const reasons: string[] = [];
  const tradeoffs: string[] = [];

  const bodyStyle = (v.bodyStyle || v.vehicleType || '').toLowerCase();
  if (prefs.vehicleTypes.length) {
    const hit = prefs.vehicleTypes.some((t) => bodyStyle.includes(t.toLowerCase()) || t.toLowerCase().includes(bodyStyle));
    if (hit) { score += 18; reasons.push(`Matches the ${v.bodyStyle || v.vehicleType} body style you're after`); }
  }

  if (prefs.brands.length) {
    const hit = prefs.brands.some((b) => b.toLowerCase() === (v.make || '').toLowerCase());
    if (hit) { score += 15; reasons.push(`${v.make} is one of your preferred brands`); }
  }

  if (prefs.budgetMax != null) {
    const min = prefs.budgetMin ?? 0;
    if (v.price >= min && v.price <= prefs.budgetMax) {
      score += 15;
      reasons.push('Fits within your budget');
    } else if (v.price > prefs.budgetMax) {
      const over = v.price - prefs.budgetMax;
      score -= 12;
      tradeoffs.push(`$${over.toLocaleString()} over your ideal budget`);
    }
  }

  if (prefs.fuelTypes.length) {
    const hit = prefs.fuelTypes.some((f) => f.toLowerCase() === (v.fuelType || '').toLowerCase());
    if (hit) { score += 10; reasons.push(`Runs on ${v.fuelType} as requested`); }
  }

  if (typeof v.mileage === 'number') {
    if (v.mileage > 0 && v.mileage < 25000) { score += 6; reasons.push('Low mileage for the year'); }
    else if (v.mileage > 90000) { score -= 6; tradeoffs.push('Higher mileage than average'); }
  }

  score = Math.max(35, Math.min(98, Math.round(score)));
  return { score, reasons: reasons.slice(0, 3), tradeoffs: tradeoffs.slice(0, 2) };
}

function toRecommendation(v: any, prefs: IShopPreferences, memberPrice?: number) {
  const { score, reasons, tradeoffs } = scoreVehicle(v, prefs);
  const location = v.dealerCity ? `${v.dealerCity}${v.dealerState ? ', ' + v.dealerState : ''}` : undefined;
  const specs = [v.mileage, v.fuelType, v.transmission, location].filter(Boolean);

  return {
    id: v._id.toString(),
    name: `${v.year} ${v.make} ${v.modelName}${v.trim ? ' ' + v.trim : ''}`,
    image: Array.isArray(v.images) && v.images.length ? v.images[0] : FALLBACK_IMAGE,
    priceLabel: memberPrice && memberPrice < v.price
      ? `$${memberPrice.toLocaleString()}`
      : `$${(v.price || 0).toLocaleString()}`,
    bodyStyle: v.bodyStyle || v.vehicleType || undefined,
    matchScore: score,
    specs,
    mileage: v.mileage || undefined,
    fuelType: v.fuelType || undefined,
    transmission: v.transmission || undefined,
    location,
    matchReasons: reasons,
    tradeoffs,
  };
}

async function findCandidates(prefs: IShopPreferences, userId?: string | null) {
  const filter: any = { status: 'Ready for Sale', isDeleted: false };

  if (prefs.brands.length) {
    filter.make = { $in: prefs.brands.map((b) => new RegExp(`^${escapeRegex(b)}$`, 'i')) };
  }
  if (prefs.fuelTypes.length) {
    filter.fuelType = { $in: prefs.fuelTypes.map((f) => new RegExp(`^${escapeRegex(f)}$`, 'i')) };
  }
  if (prefs.vehicleTypes.length) {
    const patterns = prefs.vehicleTypes.map((t) => new RegExp(escapeRegex(t), 'i'));
    filter.$or = [{ bodyStyle: { $in: patterns } }, { vehicleType: { $in: patterns } }];
  }
  if (prefs.budgetMax != null) {
    filter.price = { $lte: Math.round(prefs.budgetMax * 1.15) };
    if (prefs.budgetMin != null) filter.price.$gte = Math.round(prefs.budgetMin * 0.85);
  }

  const pool = await Vehicle.find(filter)
    .sort({ dateAdded: -1 })
    .limit(40)
    .lean();

  if (!pool.length) return [];

  let memberDiscountPercent = 0;
  if (userId) {
    try {
      const member = await membershipService.getMemberPricingForUser(userId);
      memberDiscountPercent = member?.discountPercent ?? 0;
    } catch {
      // non-fatal — proceed without member pricing
    }
  }

  const scored = pool
    .map((v: any) => {
      const memberPrice = memberDiscountPercent > 0
        ? membershipService.computeMemberPrice(v.price, v.cost, memberDiscountPercent)
        : undefined;
      return { v, rec: toRecommendation(v, prefs, memberPrice) };
    })
    .sort((a, b) => b.rec.matchScore - a.rec.matchScore)
    .slice(0, 4)
    .map((x) => x.rec);

  return scored;
}

async function buildInventoryBlurb() {
  const [total, makes, priceStats] = await Promise.all([
    Vehicle.countDocuments({ status: 'Ready for Sale', isDeleted: false }),
    Vehicle.distinct('make', { status: 'Ready for Sale', isDeleted: false }),
    Vehicle.aggregate([
      { $match: { status: 'Ready for Sale', isDeleted: false, price: { $gt: 0 } } },
      { $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } },
    ]),
  ]);
  const range = priceStats[0];
  return `${total} vehicles currently available across our dealer network. Makes on the lot: ${makes.slice(0, 25).join(', ') || 'various'}. Price range: ${range ? `$${range.min.toLocaleString()} - $${range.max.toLocaleString()}` : 'varies'}.`;
}

// ─── Reply composition (AI call #2 — only runs when we have real matches) ─────

async function composeReply(
  userMessage: string,
  recommendations: ReturnType<typeof toRecommendation>[],
  prefs: IShopPreferences
): Promise<string> {
  const vehicleList = recommendations
    .map((r) => `- ${r.name}, ${r.priceLabel}, ${r.matchScore}% match, ${r.mileage ? r.mileage.toLocaleString() + ' mi, ' : ''}${r.fuelType || ''}`)
    .join('\n');

  const systemPrompt = `You are Suprah Autrix, a warm and knowledgeable vehicle shopping assistant for a multi-dealer marketplace. You just ran a real inventory search and found these actual matching vehicles — reference them naturally by name, do not invent specs beyond what's given:

${vehicleList}

Known preferences so far: ${JSON.stringify(prefs)}

Write a short, conversational reply (2-4 sentences) responding to the user's message, pointing them toward these matches. Don't repeat prices/specs verbatim (they're shown as cards below your message) — just set context and highlight what stands out. End on a helpful, low-pressure note. No markdown headers, plain conversational text with **bold** allowed for emphasis.`;

  const response = await gemini.chat.completions.create({
    model: GEMINI_MODEL,
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
  });

  return response.choices[0]?.message?.content?.trim() || `I found ${recommendations.length} good matches for you below.`;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

export const chat = asyncHandler(async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message?.trim()) throw new ApiError(400, 'Message is required');
  if (!process.env.GEMINI_API_KEY) throw new ApiError(500, 'AI service not configured');

  const sessionId = getSessionId(req);
  const userId = (req as any).user?._id?.toString() || null;

  let chatDoc = await ShopAssistantChat.findOne({ sessionId });
  if (!chatDoc) {
    chatDoc = await ShopAssistantChat.create({ sessionId, userId, preferences: emptyPreferences(), messages: [] });
  }

  const history = chatDoc.messages.slice(-12).map((m: any) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const inventoryBlurb = await buildInventoryBlurb();
  const currentPrefs: IShopPreferences = {
    vehicleTypes: chatDoc.preferences?.vehicleTypes || [],
    budgetMin: chatDoc.preferences?.budgetMin ?? null,
    budgetMax: chatDoc.preferences?.budgetMax ?? null,
    brands: chatDoc.preferences?.brands || [],
    fuelTypes: chatDoc.preferences?.fuelTypes || [],
    passengers: chatDoc.preferences?.passengers ?? null,
    usage: chatDoc.preferences?.usage || [],
  };

  const { preferences, clarifyingQuestion, suggestions } = await extractPreferences(
    history,
    currentPrefs,
    message.trim(),
    inventoryBlurb
  );

  const hasAnyFilter =
    preferences.vehicleTypes.length ||
    preferences.brands.length ||
    preferences.fuelTypes.length ||
    preferences.budgetMax != null;

  let recommendations: ReturnType<typeof toRecommendation>[] = [];
  let replyText: string;

  if (hasAnyFilter) {
    recommendations = await findCandidates(preferences, userId);
  }

  if (recommendations.length > 0) {
    replyText = await composeReply(message.trim(), recommendations, preferences);
  } else if (clarifyingQuestion) {
    replyText = clarifyingQuestion;
  } else if (hasAnyFilter) {
    replyText = "I couldn't find an exact match for that in our current inventory — want to widen the budget or body style a bit?";
  } else {
    replyText = "Tell me a bit more — what type of vehicle, budget, or brand are you thinking about?";
  }

  chatDoc.preferences = preferences as any;
  chatDoc.messages.push({ role: 'user', content: message.trim(), createdAt: new Date() } as any);
  chatDoc.messages.push({
    role: 'assistant',
    content: replyText,
    recommendations: recommendations.length ? recommendations : undefined,
    createdAt: new Date(),
  } as any);
  if (chatDoc.messages.length > 100) chatDoc.messages.splice(0, chatDoc.messages.length - 100);
  await chatDoc.save();

  logger.info({ sessionId, recCount: recommendations.length }, '[shopAssistant] chat turn processed');

  res.json(
    new ApiResponse(
      200,
      {
        sessionId,
        message: replyText,
        recommendations,
        preferences,
        suggestions,
      },
      'Response generated'
    )
  );
});

export const getSession = asyncHandler(async (req: Request, res: Response) => {
  const sessionId = getSessionId(req);
  const chatDoc = await ShopAssistantChat.findOne({ sessionId }).lean();

  if (!chatDoc) {
    return res.json(
      new ApiResponse(200, { sessionId, messages: [], preferences: emptyPreferences(), suggestions: [] }, 'New session')
    );
  }

  res.json(
    new ApiResponse(
      200,
      {
        sessionId,
        messages: chatDoc.messages,
        preferences: chatDoc.preferences,
        suggestions: [],
      },
      'Session fetched'
    )
  );
});

export const resetSession = asyncHandler(async (req: Request, res: Response) => {
  const sessionId = getSessionId(req);
  await ShopAssistantChat.findOneAndUpdate(
    { sessionId },
    { messages: [], preferences: emptyPreferences(), messageCount: 0, lastActivityAt: new Date() },
    { upsert: true }
  );
  res.json(new ApiResponse(200, { sessionId }, 'Session reset'));
});

export default { chat, getSession, resetSession };