import { Request, Response } from "express";
import OpenAI from "openai";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Vehicle from "../models/Vehicle.model";
import CustomerShopAiSession, {
  IShopPreferences,
  CUSTOMER_SHOP_AI_DEFAULT_PREFERENCES,
} from "../models/CustomerShopAiSession.model";



const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "",
  baseURL: "https://api.groq.com/openai/v1",
});

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";


const TYPE_TO_BODYSTYLE: Record<string, string[]> = {
  suv: ["suv", "sport utility", "crossover", "cuv"],
  sedan: ["sedan", "saloon"],
  truck: ["truck", "pickup", "pick-up"],
  coupe: ["coupe", "coupé"],
  hatchback: ["hatchback", "hatch"],
  van: ["van", "minivan", "mpv"],
  minivan: ["minivan", "van", "mpv"],
  convertible: ["convertible", "cabriolet", "roadster"],
  wagon: ["wagon", "estate"],
};

const USAGE_TO_BODYSTYLE: Record<string, string[]> = {
  family: ["suv", "minivan", "van", "sedan", "wagon", "crossover"],
  "off-road": ["suv", "truck", "pickup"],
  offroad: ["suv", "truck", "pickup"],
  commute: ["sedan", "hatchback", "coupe", "suv", "crossover"],
  daily: ["sedan", "hatchback", "coupe", "suv", "crossover"],
  business: ["sedan", "suv", "coupe"],
  luxury: ["sedan", "suv", "coupe", "convertible"],
  towing: ["truck", "pickup", "suv"],
  hauling: ["truck", "pickup", "van"],
  cargo: ["van", "truck", "pickup"],
  adventure: ["suv", "truck"],
};

const WEIGHTS = {
  budget: 30,
  vehicleType: 22,
  brand: 16,
  fuelType: 14,
  usage: 10,
  passengers: 8,
};

const CANDIDATE_LIMIT = 120;
const TOP_N = 6;
const MAX_HISTORY_TURNS = 24;


const lc = (s: any) => (typeof s === "string" ? s.toLowerCase().trim() : "");
const uniqMerge = (a: string[] = [], b: string[] = []) =>
  Array.from(new Set([...a, ...b].map((x) => x.trim()).filter(Boolean)));

function parseJsonObject(raw: string): any {
  if (!raw) return {};
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return {};
  }
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mergePreferences(
  current: IShopPreferences,
  delta: any
): IShopPreferences {
  const next: IShopPreferences = {
    ...CUSTOMER_SHOP_AI_DEFAULT_PREFERENCES(),
    ...current,
  };

  if (delta?.reset === true) {
    return CUSTOMER_SHOP_AI_DEFAULT_PREFERENCES();
  }

  const clear: string[] = Array.isArray(delta?.clear) ? delta.clear : [];

  const applyArray = (key: keyof IShopPreferences, incoming: any) => {
    if (clear.includes(key as string)) {
      (next as any)[key] = [];
    }
    if (Array.isArray(incoming) && incoming.length) {
      (next as any)[key] = uniqMerge((next as any)[key], incoming.map(String));
    }
  };

  applyArray("vehicleTypes", delta?.vehicleTypes);
  applyArray("brands", delta?.brands);
  applyArray("fuelTypes", delta?.fuelTypes);
  applyArray("usage", delta?.usage);
  applyArray("features", delta?.features);

  const applyScalar = (key: keyof IShopPreferences, incoming: any) => {
    if (clear.includes(key as string)) {
      (next as any)[key] = null;
      return;
    }
    const n = num(incoming);
    if (n !== null) (next as any)[key] = n;
  };

  applyScalar("budgetMin", delta?.budgetMin);
  applyScalar("budgetMax", delta?.budgetMax);
  applyScalar("passengers", delta?.passengers);
  applyScalar("yearMin", delta?.yearMin);
  applyScalar("maxMileage", delta?.maxMileage);

  if (
    next.budgetMin != null &&
    next.budgetMax != null &&
    next.budgetMin > next.budgetMax
  ) {
    const t = next.budgetMin;
    next.budgetMin = next.budgetMax;
    next.budgetMax = t;
  }

  return next;
}

function hasAnyPreference(p: IShopPreferences): boolean {
  return Boolean(
    p.vehicleTypes.length ||
      p.brands.length ||
      p.fuelTypes.length ||
      p.usage.length ||
      p.features.length ||
      p.budgetMin != null ||
      p.budgetMax != null ||
      p.passengers != null ||
      p.yearMin != null ||
      p.maxMileage != null
  );
}


function buildCandidateFilter(p: IShopPreferences, relaxBudget = false): any {
  const filter: any = { status: "Ready for Sale", isDeleted: false };

  if (p.brands.length) {
    filter.make = { $in: p.brands.map((b) => new RegExp(`^${escapeRegex(b)}`, "i")) };
  }
  if (p.fuelTypes.length) {
    filter.fuelType = {
      $in: p.fuelTypes.map((f) => new RegExp(escapeRegex(f), "i")),
    };
  }
  if (!relaxBudget && p.budgetMax != null) {
    // 20% headroom so near-budget alternatives can still appear & be explained.
    filter.price = { $gt: 0, $lte: Math.round(p.budgetMax * 1.2) };
  }
  if (p.maxMileage != null) {
    filter.mileage = { $lte: Math.round(p.maxMileage * 1.2) };
  }
  if (p.yearMin != null) {
    filter.year = { $gte: p.yearMin };
  }
  return filter;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchCandidates(p: IShopPreferences): Promise<any[]> {
  let candidates = await Vehicle.find(buildCandidateFilter(p))
    .limit(CANDIDATE_LIMIT)
    .lean();

  if (candidates.length < 3) {
    candidates = await Vehicle.find(buildCandidateFilter(p, true))
      .limit(CANDIDATE_LIMIT)
      .lean();
  }
  if (candidates.length === 0) {
    candidates = await Vehicle.find({
      status: "Ready for Sale",
      isDeleted: false,
    })
      .limit(CANDIDATE_LIMIT)
      .lean();
  }
  return candidates;
}


interface ScoreResult {
  score: number;
  reasons: string[];
  tradeoffs: string[];
}

function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

function scoreVehicle(v: any, p: IShopPreferences): ScoreResult {
  let earned = 0;
  let possible = 0;
  const reasons: string[] = [];
  const tradeoffs: string[] = [];

  const body = lc(v.bodyStyle);
  const make = lc(v.make);
  const fuel = lc(v.fuelType);
  const price = Number(v.price) || 0;

  if (p.budgetMax != null || p.budgetMin != null) {
    possible += WEIGHTS.budget;
    const min = p.budgetMin ?? 0;
    const max = p.budgetMax ?? Infinity;
    if (price > 0 && price >= min && price <= max) {
      earned += WEIGHTS.budget;
      reasons.push(`Priced at ${fmtMoney(price)} — within your budget`);
    } else if (price > 0 && price > max) {
      const over = (price - max) / max;
      if (over <= 0.1) {
        earned += WEIGHTS.budget * 0.6;
        tradeoffs.push(`Slightly above budget at ${fmtMoney(price)}`);
      } else if (over <= 0.25) {
        earned += WEIGHTS.budget * 0.3;
        tradeoffs.push(`About ${Math.round(over * 100)}% over budget`);
      } else {
        tradeoffs.push(`Above your budget at ${fmtMoney(price)}`);
      }
    } else if (price > 0 && price < min) {
      earned += WEIGHTS.budget * 0.85; // under budget is fine
      reasons.push(`Comes in under budget at ${fmtMoney(price)}`);
    }
  }

  // Vehicle type ---------------------------------------------------------------
  if (p.vehicleTypes.length) {
    possible += WEIGHTS.vehicleType;
    const wanted = p.vehicleTypes.flatMap(
      (t) => TYPE_TO_BODYSTYLE[lc(t)] || [lc(t)]
    );
    if (body && wanted.some((w) => body.includes(w))) {
      earned += WEIGHTS.vehicleType;
      reasons.push(`Body style matches (${v.bodyStyle})`);
    } else if (body) {
      tradeoffs.push(
        `Body style is ${v.bodyStyle}, not your preferred ${p.vehicleTypes.join("/")}`
      );
    }
  }

  // Brand ----------------------------------------------------------------------
  if (p.brands.length) {
    possible += WEIGHTS.brand;
    if (make && p.brands.some((b) => make.includes(lc(b)) || lc(b).includes(make))) {
      earned += WEIGHTS.brand;
      reasons.push(`${v.make} is one of your preferred brands`);
    } else {
      tradeoffs.push(`${v.make} (outside your preferred brands)`);
    }
  }

  // Fuel type ------------------------------------------------------------------
  if (p.fuelTypes.length) {
    possible += WEIGHTS.fuelType;
    if (fuel && p.fuelTypes.some((f) => fuel.includes(lc(f)))) {
      earned += WEIGHTS.fuelType;
      reasons.push(`${v.fuelType} powertrain, as requested`);
    } else if (fuel) {
      tradeoffs.push(`${v.fuelType} (you asked for ${p.fuelTypes.join("/")})`);
    }
  }

  // Usage (soft body-style affinity) ------------------------------------------
  if (p.usage.length) {
    possible += WEIGHTS.usage;
    const affinity = p.usage.flatMap((u) => USAGE_TO_BODYSTYLE[lc(u)] || []);
    if (affinity.length && body && affinity.some((a) => body.includes(a))) {
      earned += WEIGHTS.usage;
      reasons.push(`Well suited for ${p.usage.join(", ")}`);
    } else if (affinity.length) {
      earned += WEIGHTS.usage * 0.25;
    } else {
      // Usage we have no mapping for — don't penalize; let the LLM reason about it.
      earned += WEIGHTS.usage * 0.5;
    }
  }

  // Passenger capacity (heuristic from body style / doors) ---------------------
  if (p.passengers != null) {
    possible += WEIGHTS.passengers;
    const big = ["suv", "van", "minivan", "truck", "crossover", "wagon"];
    const small = ["coupe", "convertible", "roadster"];
    let ok = true;
    if (p.passengers >= 6) ok = big.some((b) => body.includes(b));
    else if (p.passengers <= 2) ok = !big.some((b) => body.includes(b));
    if (ok) {
      earned += WEIGHTS.passengers;
      reasons.push(`Fits around ${p.passengers} passengers`);
    } else {
      earned += WEIGHTS.passengers * 0.3;
      if (p.passengers >= 6)
        tradeoffs.push(`May be tight for ${p.passengers} passengers`);
    }
  }

  // No expressed preferences yet → neutral baseline so we can still show stock.
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 60;
  return { score: Math.max(0, Math.min(100, score)), reasons, tradeoffs };
}

// Shape a recommendation card from a vehicle doc + its score.
function toRecommendationCard(v: any, s: ScoreResult) {
  const image =
    (Array.isArray(v.images)
      ? v.images.find((i: string) => typeof i === "string" && i.trim())
      : null) ||
    "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop";

  const specs = [
    v.mileage != null ? `${Number(v.mileage).toLocaleString()} mi` : null,
    v.transmission || null,
    v.fuelType || null,
    v.driveTrain || null,
    v.engine || null,
  ].filter(Boolean);

  return {
    id: v._id?.toString(),
    vin: v.vin,
    name: `${v.year} ${v.make} ${v.modelName}`,
    year: v.year,
    make: v.make,
    model: v.modelName,
    trim: v.trim || "",
    price: v.price || 0,
    priceLabel: v.price ? fmtMoney(v.price) : "Contact for price",
    mileage: v.mileage || 0,
    bodyStyle: v.bodyStyle || "",
    fuelType: v.fuelType || "",
    transmission: v.transmission || "",
    driveTrain: v.driveTrain || "",
    exteriorColor: v.exteriorColor || "",
    image,
    location: v.dealerCity
      ? `${v.dealerCity}${v.dealerState ? ", " + v.dealerState : ""}`
      : "",
    specs,
    matchScore: s.score,
    matchReasons: s.reasons.slice(0, 4),
    tradeoffs: s.tradeoffs.slice(0, 2),
  };
}

async function buildRecommendations(p: IShopPreferences) {
  const candidates = await fetchCandidates(p);
  const scored = candidates
    .map((v) => ({ v, s: scoreVehicle(v, p) }))
    .sort((a, b) => b.s.score - a.s.score || (a.v.price || 0) - (b.v.price || 0))
    .slice(0, TOP_N)
    .map(({ v, s }) => toRecommendationCard(v, s));

  const exactMatches = scored.filter((r) => r.matchScore >= 75 && !r.tradeoffs.length);
  return {
    recommendations: scored,
    isExact: exactMatches.length > 0,
    candidateCount: candidates.length,
  };
}

// Deterministic quick-reply chips based on what's still unknown.
function buildSuggestions(p: IShopPreferences): string[] {
  const out: string[] = [];
  if (!p.vehicleTypes.length)
    out.push("I want an SUV", "Show me sedans", "I'm after a truck");
  if (p.budgetMax == null)
    out.push("Budget under $30,000", "Budget $30k–$50k");
  if (!p.fuelTypes.length) out.push("Electric or hybrid", "Gasoline is fine");
  if (!p.usage.length)
    out.push("It's a family vehicle", "Mostly daily commuting");
  if (!p.brands.length && p.vehicleTypes.length)
    out.push("Any reliable brand");
  // Always offer refinement actions once we have something.
  if (hasAnyPreference(p)) {
    out.push("Show me cheaper options", "What's the best value here?");
  }
  return out.slice(0, 5);
}

// ─── LLM steps ───────────────────────────────────────────────────────────────

async function extractPreferences(
  message: string,
  current: IShopPreferences,
  recentHistory: { role: string; content: string }[]
): Promise<IShopPreferences> {
  if (!process.env.GROQ_API_KEY) return current;

  const system = `You extract structured car-shopping preferences from a customer's message.
Return ONLY a JSON object (no prose, no markdown) with any of these keys that the customer EXPRESSED or clearly implied in their latest message:

{
  "vehicleTypes": string[],
  "brands": string[],
  "fuelTypes": string[],
  "usage": string[],
  "features": string[],
  "budgetMin": number|null,
  "budgetMax": number|null,
  "passengers": number|null,
  "yearMin": number|null,
  "maxMileage": number|null,
  "clear": string[],
  "reset": boolean
}

Rules:
- Only include keys the customer actually conveyed in their LATEST message. Omit everything else.
- Normalize synonyms to the canonical values above (e.g. "crossover" -> "SUV", "EV" -> "Electric").
- Never invent values. Numbers must be plain integers (no "$" or "k").
- Current known preferences (for reference only, do not repeat unless changed): ${JSON.stringify(current)}`;

  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 400,
      temperature: 0,
      response_format: { type: "json_object" } as any,
      messages: [
        { role: "system", content: system },
        ...recentHistory.slice(-4).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user", content: message },
      ],
    });
    const delta = parseJsonObject(resp.choices[0]?.message?.content || "{}");
    return mergePreferences(current, delta);
  } catch {
    return current; // extraction failure shouldn't break the chat
  }
}

function summarizePrefs(p: IShopPreferences): string {
  const bits: string[] = [];
  if (p.vehicleTypes.length) bits.push(`Type: ${p.vehicleTypes.join(", ")}`);
  if (p.budgetMin != null || p.budgetMax != null)
    bits.push(
      `Budget: ${p.budgetMin != null ? fmtMoney(p.budgetMin) : "any"} – ${
        p.budgetMax != null ? fmtMoney(p.budgetMax) : "any"
      }`
    );
  if (p.brands.length) bits.push(`Brands: ${p.brands.join(", ")}`);
  if (p.fuelTypes.length) bits.push(`Fuel: ${p.fuelTypes.join(", ")}`);
  if (p.passengers != null) bits.push(`Passengers: ${p.passengers}`);
  if (p.usage.length) bits.push(`Usage: ${p.usage.join(", ")}`);
  if (p.features.length) bits.push(`Features: ${p.features.join(", ")}`);
  if (p.maxMileage != null) bits.push(`Max mileage: ${p.maxMileage}`);
  return bits.length ? bits.join(" · ") : "none yet";
}

async function generateReply(opts: {
  customerName?: string;
  message: string;
  preferences: IShopPreferences;
  recommendations: any[];
  isExact: boolean;
  history: { role: "user" | "assistant"; content: string }[];
}): Promise<string> {
  const { customerName, message, preferences, recommendations, isExact, history } =
    opts;

  const recBlock = recommendations.length
    ? recommendations
        .map(
          (r, i) =>
            `${i + 1}. ${r.name} — ${r.priceLabel} (match ${r.matchScore}%)` +
            (r.matchReasons.length ? ` | fits: ${r.matchReasons.join("; ")}` : "") +
            (r.tradeoffs.length ? ` | note: ${r.tradeoffs.join("; ")}` : "")
        )
        .join("\n")
    : "(no recommendations generated this turn)";

  const system = `You are Suprah Autrix, a warm, knowledgeable personal vehicle consultant helping a customer shop our dealership inventory${
    customerName ? ` (customer: ${customerName})` : ""
  }.

Known preferences so far: ${summarizePrefs(preferences)}

${
  recommendations.length
    ? `The system has selected these REAL in-stock vehicles to show the customer as cards (do NOT re-list every spec — the cards already display name, price, specs and match score):\n${recBlock}\n\n${
        isExact
          ? "These are strong matches."
          : "These are the CLOSEST available matches (no exact match in stock) — briefly, honestly acknowledge the trade-offs."
      }`
    : "No vehicles are being shown this turn — you still need more information."
}

Guidelines:
- Sound like a helpful human consultant, never robotic. 2–5 short sentences.
- If vehicles are shown, give a one-line framing of why they fit (reference 1–2 by name), then ask ONE focused follow-up question to refine further.
- If no vehicles are shown, ask the single most useful next question (prioritize: vehicle type, then budget, then fuel/usage).
- NEVER invent vehicles, prices, or specs beyond what's listed above.
- Use light markdown only if it helps. Do not output a JSON or a list of the cards.`;

  const resp = await groq.chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: 380,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      ...history.slice(-MAX_HISTORY_TURNS),
      { role: "user", content: message },
    ],
  });

  return (
    resp.choices[0]?.message?.content?.trim() ||
    "Tell me a bit about what you're looking for — vehicle type, budget, or how you'll use it — and I'll find the best matches in our inventory."
  );
}


function resolveSessionKey(req: Request): {
  key: string;
  customerUserId: string | null;
} {
  const u: any = (req as any).user || (req as any).customer || null;
  const customerUserId = u?._id?.toString() || u?.id || null;
  const clientSessionId =
    (req.body?.sessionId as string) || (req.query?.sessionId as string) || "";

  if (customerUserId) return { key: `cust:${customerUserId}`, customerUserId };
  if (clientSessionId) return { key: `anon:${clientSessionId}`, customerUserId: null };
  throw new ApiError(400, "A sessionId is required when no customer is signed in.");
}

async function getOrCreateSession(req: Request) {
  const { key, customerUserId } = resolveSessionKey(req);
  let session = await CustomerShopAiSession.findOne({ sessionKey: key });
  if (!session) {
    session = await CustomerShopAiSession.create({
      sessionKey: key,
      customerUserId: customerUserId || null,
      preferences: CUSTOMER_SHOP_AI_DEFAULT_PREFERENCES(),
      messages: [],
    });
  }
  return session;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/customer-shop-ai/chat
 * Body: { message: string, sessionId?: string }
 * Returns: { reply, preferences, recommendations[], suggestions[], isExact, sessionId }
 */
export const chat = asyncHandler(async (req: Request, res: Response) => {
  const { message } = req.body || {};
  if (!message?.trim()) throw new ApiError(400, "Message is required");
  if (!process.env.GROQ_API_KEY)
    throw new ApiError(503, "AI service is not configured");

  const session = await getOrCreateSession(req);
  const customerName =
    (req as any).user?.firstName ||
    (req as any).user?.fullName ||
    (req as any).user?.name ||
    undefined;

  const history = session.messages.slice(-MAX_HISTORY_TURNS).map((m: any) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // 1) Update the preference profile from the new message.
  const updatedPrefs = await extractPreferences(
    message.trim(),
    session.preferences,
    history
  );

  // 2) Deterministically recommend real inventory (only once we know something).
  let recommendations: any[] = [];
  let isExact = false;
  if (hasAnyPreference(updatedPrefs)) {
    const built = await buildRecommendations(updatedPrefs);
    recommendations = built.recommendations;
    isExact = built.isExact;
  }

  // 3) Conversational reply that references the real recommendations.
  const reply = await generateReply({
    customerName,
    message: message.trim(),
    preferences: updatedPrefs,
    recommendations,
    isExact,
    history,
  });

  // 4) Persist.
  session.preferences = updatedPrefs;
  session.messages.push({
    role: "user",
    content: message.trim(),
    createdAt: new Date(),
  } as any);
  session.messages.push({
    role: "assistant",
    content: reply,
    recommendations,
    createdAt: new Date(),
  } as any);
  if (session.messages.length > 200)
    session.messages.splice(0, session.messages.length - 200);
  session.messageCount = session.messages.length;
  session.lastActivityAt = new Date();
  await session.save();

  res.json(
    new ApiResponse(
      200,
      {
        reply,
        preferences: updatedPrefs,
        recommendations,
        isExact,
        suggestions: buildSuggestions(updatedPrefs),
        sessionId: session.sessionKey,
      },
      "Response generated"
    )
  );
});

/**
 * GET /api/customer-shop-ai/session?sessionId=...
 * Restores the conversation + preferences on page load.
 */
export const getSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await getOrCreateSession(req);
  res.json(
    new ApiResponse(
      200,
      {
        sessionId: session.sessionKey,
        preferences: session.preferences,
        messages: session.messages.slice(-MAX_HISTORY_TURNS * 2),
        suggestions: buildSuggestions(session.preferences),
      },
      "Session fetched"
    )
  );
});

/**
 * POST /api/customer-shop-ai/recommend
 * Re-run recommendations against the current (or supplied) preferences without a
 * chat turn — handy for quick-action chips that just tweak a filter.
 * Body: { sessionId?, preferences? (partial delta) }
 */
export const recommend = asyncHandler(async (req: Request, res: Response) => {
  const session = await getOrCreateSession(req);
  if (req.body?.preferences) {
    session.preferences = mergePreferences(
      session.preferences,
      req.body.preferences
    );
    await session.save();
  }
  const built = await buildRecommendations(session.preferences);
  res.json(
    new ApiResponse(
      200,
      {
        preferences: session.preferences,
        recommendations: built.recommendations,
        isExact: built.isExact,
        suggestions: buildSuggestions(session.preferences),
        sessionId: session.sessionKey,
      },
      "Recommendations generated"
    )
  );
});

/**
 * POST /api/customer-shop-ai/reset
 * Clears the conversation and preference profile for a fresh start.
 */
export const reset = asyncHandler(async (req: Request, res: Response) => {
  const session = await getOrCreateSession(req);
  session.messages = [] as any;
  session.preferences = CUSTOMER_SHOP_AI_DEFAULT_PREFERENCES();
  session.messageCount = 0;
  session.lastActivityAt = new Date();
  await session.save();
  res.json(new ApiResponse(200, { sessionId: session.sessionKey }, "Session reset"));
});

// ROADMAP: add `compare`, `financing`, `tradeIn`, `bookAppointment`, `createLead`
// handlers here. They can reuse `getOrCreateSession` + `session.preferences`
// and (for lead-gen) write to the existing Lead model.

export default {
  chat,
  getSession,
  recommend,
  reset,
};