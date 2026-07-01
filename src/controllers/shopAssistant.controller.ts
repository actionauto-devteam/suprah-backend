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

// ─── Gemini client — identical setup to supraLeo.controller.ts ────────────────

const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop';

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
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function getSessionId(req: Request): string {
  const fromHeader = req.header('x-shop-session-id');
  const fromBody = req.body?.sessionId;
  const fromQuery = req.query?.sessionId as string | undefined;
  return (fromHeader || fromBody || fromQuery || crypto.randomUUID()) as string;
}

// ─── Context fetcher — same job as supraLeo's fetchModuleContext(), ───────────
// ─── but pulling REAL vehicle inventory instead of leads/appointments ─────────

async function fetchVehicleContext(prefs: IShopPreferences) {
  const filter: any = { status: 'Ready for Sale', isDeleted: false };

  if (prefs.brands.length) {
    filter.make = { $in: prefs.brands.map((b) => new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) };
  }
  if (prefs.fuelTypes.length) {
    filter.fuelType = { $in: prefs.fuelTypes.map((f) => new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) };
  }
  if (prefs.vehicleTypes.length) {
    const patterns = prefs.vehicleTypes.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    filter.$or = [{ bodyStyle: { $in: patterns } }, { vehicleType: { $in: patterns } }];
  }
  if (prefs.budgetMax != null) {
    filter.price = { $lte: Math.round(prefs.budgetMax * 1.15) };
    if (prefs.budgetMin != null) filter.price.$gte = Math.round(prefs.budgetMin * 0.85);
  }

  // If nothing scoped yet, just hand the model a representative recent sample —
  // same idea as fetchModuleContext's "recentLeads" fallback when nothing is filtered.
  const pool = await Vehicle.find(filter)
    .sort({ dateAdded: -1 })
    .limit(30)
    .select(
      'year make modelName trim price mileage fuelType transmission bodyStyle vehicleType dealerCity dealerState images'
    )
    .lean();

  const [total, makes] = await Promise.all([
    Vehicle.countDocuments({ status: 'Ready for Sale', isDeleted: false }),
    Vehicle.distinct('make', { status: 'Ready for Sale', isDeleted: false }),
  ]);

  return {
    totalAvailable: total,
    allMakesOnLot: makes.slice(0, 30),
    candidateVehicles: pool.map((v: any) => ({
      id: v._id.toString(),
      year: v.year,
      make: v.make,
      model: v.modelName,
      trim: v.trim || '',
      price: v.price || 0,
      mileage: v.mileage || 0,
      fuelType: v.fuelType || 'Gasoline',
      transmission: v.transmission || 'Automatic',
      bodyStyle: v.bodyStyle || v.vehicleType || '',
      location: v.dealerCity ? `${v.dealerCity}${v.dealerState ? ', ' + v.dealerState : ''}` : 'Unknown',
    })),
  };
}

// ─── System prompt — same job as supraLeo's buildSystemPrompt() ───────────────

function buildSystemPrompt(contextData: any, prefs: IShopPreferences): string {
  return `You are Suprah Autrix, the intelligent AI vehicle-shopping assistant embedded in a multi-dealer marketplace. You are warm, confident, and genuinely helpful — never pushy.

Current time: ${new Date().toLocaleString()}
Known customer preferences so far: ${JSON.stringify(prefs)}

Live inventory context (this is REAL, currently available stock — you may ONLY recommend vehicles from this list, never invent a vehicle or specs that aren't here):
Total vehicles available across the network: ${contextData.totalAvailable}
Makes on the lot: ${contextData.allMakesOnLot.join(', ') || 'various'}
Candidate vehicles matching the conversation so far:
${JSON.stringify(contextData.candidateVehicles, null, 2)}

Your job:
- Understand what the customer wants (type, budget, brand, fuel, usage, passengers) from the conversation
- Update and track their preferences as the conversation progresses — carry forward what you already know, only change it if they contradict themselves
- Recommend up to 4 vehicles STRICTLY from the candidate list above, ranked best-fit first
- If the candidate list is empty or nothing truly fits, say so honestly and suggest what to adjust (budget, body style) rather than forcing a bad match
- If you don't have enough info yet (no body style, budget, or brand mentioned at all), ask ONE short clarifying question instead of guessing

Respond with ONLY this JSON — no markdown fences, no commentary outside the JSON:
{
  "reply": "2-4 sentence conversational reply, plain text, **bold** allowed for emphasis, no headers",
  "preferences": {
    "vehicleTypes": string[],
    "budgetMin": number | null,
    "budgetMax": number | null,
    "brands": string[],
    "fuelTypes": string[],
    "passengers": number | null,
    "usage": string[]
  },
  "recommendedVehicleIds": string[],   // "id" values copied EXACTLY from the candidate list, 0-4 items, best match first
  "matchNotes": { "<vehicleId>": { "reasons": string[], "tradeoffs": string[] } },  // 1-3 short reasons/tradeoffs per recommended id, plain text, no numbers
  "suggestions": string[]   // 3 short follow-up phrases phrased as if the USER is saying them
}`;
}

// ─── Hydration — numbers always come from the DB record, never from the model ─

function hydrateRecommendation(vehicleDoc: any, notes: { reasons?: string[]; tradeoffs?: string[] } | undefined, prefs: IShopPreferences, memberPrice?: number) {
  const location = vehicleDoc.dealerCity ? `${vehicleDoc.dealerCity}${vehicleDoc.dealerState ? ', ' + vehicleDoc.dealerState : ''}` : undefined;
  const specs = [vehicleDoc.mileage, vehicleDoc.fuelType, vehicleDoc.transmission, location].filter(Boolean);

  // Lightweight deterministic score purely for the badge — never AI-generated,
  // so the % shown on the card can't be hallucinated.
  let score = 60;
  if (prefs.vehicleTypes.length) {
    const bs = (vehicleDoc.bodyStyle || vehicleDoc.vehicleType || '').toLowerCase();
    if (prefs.vehicleTypes.some((t) => bs.includes(t.toLowerCase()))) score += 15;
  }
  if (prefs.brands.length && prefs.brands.some((b) => b.toLowerCase() === (vehicleDoc.make || '').toLowerCase())) score += 15;
  if (prefs.budgetMax != null && vehicleDoc.price <= prefs.budgetMax) score += 10;
  score = Math.max(40, Math.min(97, score));

  return {
    id: vehicleDoc._id.toString(),
    name: `${vehicleDoc.year} ${vehicleDoc.make} ${vehicleDoc.modelName}${vehicleDoc.trim ? ' ' + vehicleDoc.trim : ''}`,
    image: Array.isArray(vehicleDoc.images) && vehicleDoc.images.length ? vehicleDoc.images[0] : FALLBACK_IMAGE,
    priceLabel: memberPrice && memberPrice < vehicleDoc.price ? `$${memberPrice.toLocaleString()}` : `$${(vehicleDoc.price || 0).toLocaleString()}`,
    bodyStyle: vehicleDoc.bodyStyle || vehicleDoc.vehicleType || undefined,
    matchScore: score,
    specs,
    mileage: vehicleDoc.mileage || undefined,
    fuelType: vehicleDoc.fuelType || undefined,
    transmission: vehicleDoc.transmission || undefined,
    location,
    matchReasons: (notes?.reasons || []).slice(0, 3),
    tradeoffs: (notes?.tradeoffs || []).slice(0, 2),
  };
}

// ─── Controller — same shape as supraLeo's chat() ──────────────────────────────

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

  const currentPrefs: IShopPreferences = {
    vehicleTypes: chatDoc.preferences?.vehicleTypes || [],
    budgetMin: chatDoc.preferences?.budgetMin ?? null,
    budgetMax: chatDoc.preferences?.budgetMax ?? null,
    brands: chatDoc.preferences?.brands || [],
    fuelTypes: chatDoc.preferences?.fuelTypes || [],
    passengers: chatDoc.preferences?.passengers ?? null,
    usage: chatDoc.preferences?.usage || [],
  };

  // 1. Fetch real inventory context — same role as fetchModuleContext()
  const contextData = await fetchVehicleContext(currentPrefs);

  // 2. Build system prompt with that context baked in
  const systemPrompt = buildSystemPrompt(contextData, currentPrefs);

  // 3. Recent turns + latest message — same as supraLeo
  const recentMessages = chatDoc.messages.slice(-20).map((m: any) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  recentMessages.push({ role: 'user', content: message.trim() });

  // 4. ONE Gemini call — same as supraLeo's non-streaming branch
  const response = await gemini.chat.completions.create({
    model: GEMINI_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
    stream: false,
  });

  const raw = response.choices[0]?.message?.content || '{}';
  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch (err) {
    logger.warn({ err, raw }, '[shopAssistant] Failed to parse model JSON');
    parsed = { reply: raw, preferences: currentPrefs, recommendedVehicleIds: [], matchNotes: {}, suggestions: [] };
  }

  const nextPrefs: IShopPreferences = {
    vehicleTypes: Array.isArray(parsed.preferences?.vehicleTypes) ? parsed.preferences.vehicleTypes : currentPrefs.vehicleTypes,
    budgetMin: parsed.preferences?.budgetMin ?? currentPrefs.budgetMin ?? null,
    budgetMax: parsed.preferences?.budgetMax ?? currentPrefs.budgetMax ?? null,
    brands: Array.isArray(parsed.preferences?.brands) ? parsed.preferences.brands : currentPrefs.brands,
    fuelTypes: Array.isArray(parsed.preferences?.fuelTypes) ? parsed.preferences.fuelTypes : currentPrefs.fuelTypes,
    passengers: parsed.preferences?.passengers ?? currentPrefs.passengers ?? null,
    usage: Array.isArray(parsed.preferences?.usage) ? parsed.preferences.usage : currentPrefs.usage,
  };

  // 5. Hydrate recommendations — cross-check every id against the ACTUAL candidate
  //    pool the model was given. Anything hallucinated (id not in our list) is dropped.
  const candidateIds = new Set(contextData.candidateVehicles.map((v: any) => v.id));
  const requestedIds: string[] = Array.isArray(parsed.recommendedVehicleIds) ? parsed.recommendedVehicleIds : [];
  const validIds = requestedIds.filter((id) => candidateIds.has(id)).slice(0, 4);

  let recommendations: ReturnType<typeof hydrateRecommendation>[] = [];
  if (validIds.length) {
    const vehicleDocs = await Vehicle.find({ _id: { $in: validIds } }).lean();

    let memberDiscountPercent = 0;
    if (userId) {
      try {
        const member = await membershipService.getMemberPricingForUser(userId);
        memberDiscountPercent = member?.discountPercent ?? 0;
      } catch {
        // non-fatal
      }
    }

    const byId = new Map(vehicleDocs.map((v: any) => [v._id.toString(), v]));
    recommendations = validIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((v: any) => {
        const memberPrice = memberDiscountPercent > 0 ? membershipService.computeMemberPrice(v.price, v.cost, memberDiscountPercent) : undefined;
        return hydrateRecommendation(v, parsed.matchNotes?.[v._id.toString()], nextPrefs, memberPrice);
      });
  }

  const replyText: string = parsed.reply || "Let me know what you're looking for — type, budget, or brand — and I'll check our live inventory.";
  const suggestions: string[] = Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 4) : [];

  // 6. Persist — same pattern as supraLeo's chatDoc.messages.push(...) + save()
  chatDoc.preferences = nextPrefs as any;
  chatDoc.messages.push({ role: 'user', content: message.trim(), createdAt: new Date() } as any);
  chatDoc.messages.push({
    role: 'assistant',
    content: replyText,
    recommendations: recommendations.length ? recommendations : undefined,
    createdAt: new Date(),
  } as any);
  if (chatDoc.messages.length > 100) chatDoc.messages.splice(0, chatDoc.messages.length - 100);
  await chatDoc.save();

  res.json(
    new ApiResponse(200, { sessionId, message: replyText, recommendations, preferences: nextPrefs, suggestions }, 'Response generated')
  );
});

export const getSession = asyncHandler(async (req: Request, res: Response) => {
  const sessionId = getSessionId(req);
  const chatDoc = await ShopAssistantChat.findOne({ sessionId }).lean();
  if (!chatDoc) {
    return res.json(new ApiResponse(200, { sessionId, messages: [], preferences: emptyPreferences(), suggestions: [] }, 'New session'));
  }
  res.json(new ApiResponse(200, { sessionId, messages: chatDoc.messages, preferences: chatDoc.preferences, suggestions: [] }, 'Session fetched'));
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