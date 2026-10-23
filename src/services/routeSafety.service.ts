/*
 * A second check on every route Amazon Location plans: its notices say when
 * the route breaks, or may break, one of the truck's limits (a low bridge, a
 * weight limit, a road closed to trucks, a blocked road). Suprah never shows
 * a route that breaks a limit as the way to go, and warns when one may apply.
 *
 * Notice codes are Amazon Location's (RouteVehicleNoticeCode). Limits come in
 * centimetres and kilograms, the same units the truck profile is sent in.
 */

/** Amazon couldn't avoid one of the truck's limits on this route. */
const BREAKS_A_LIMIT = new Set([
  "ViolatedVehicleRestriction",
  "ViolatedBlockedRoad",
  "ViolatedTurnRestriction",
  "ViolatedZoneRestriction",
  "ViolatedAvoidTruckRoadType",
  "ViolatedEmergencyGate",
]);

/** One of the truck's limits may apply, or a road on the route may be closed for the season. */
const MAY_BREAK_A_LIMIT = new Set([
  "PotentialViolatedVehicleRestrictionUsage",
  "PotentialViolatedTurnRestrictionUsage",
  "PotentialViolatedZoneRestrictionUsage",
  "SeasonalClosure",
]);

export type LegSafety = {
  status: "ok" | "check" | "unsafe";
  /** Plain-English limits, for example "a 12 ft 6 in height limit". */
  limits: string[];
};

function feetAndInches(centimetres: number): string {
  const totalInches = Math.round(centimetres / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return inches ? `${feet} ft ${inches} in` : `${feet} ft`;
}

function pounds(kilograms: number): string {
  const lb = kilograms * 2.20462;
  const rounded = lb >= 10_000 ? Math.round(lb / 1_000) * 1_000 : Math.round(lb / 100) * 100;
  return `${rounded.toLocaleString("en-US")} lb`;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** "a 12 ft ...", but "an 8 ft ...", "an 11,000 lb ...", "an 18 ft ...". */
function withArticle(text: string): string {
  const lead = text.match(/^\d+/)?.[0] ?? "";
  return lead.startsWith("8") || lead === "11" || lead === "18" ? `an ${text}` : `a ${text}`;
}

/** The measured limits in one notice detail, for example "a 12 ft 6 in height limit". */
function measuredLimits(limit: any): string[] {
  const limits: string[] = [];
  if (positive(limit?.MaxHeight)) limits.push(withArticle(`${feetAndInches(limit.MaxHeight)} height limit`));
  if (positive(limit?.MaxLength)) limits.push(withArticle(`${feetAndInches(limit.MaxLength)} length limit`));
  if (positive(limit?.MaxWidth)) limits.push(withArticle(`${feetAndInches(limit.MaxWidth)} width limit`));
  if (positive(limit?.MaxWeight?.Value)) limits.push(withArticle(`${pounds(limit.MaxWeight.Value)} weight limit`));
  if (positive(limit?.MaxWeightPerAxle)) limits.push(withArticle(`${pounds(limit.MaxWeightPerAxle)} per-axle weight limit`));
  return limits;
}

/** The kind of limit, when the notice gives no numbers. */
function kindOfLimit(code: string): string {
  if (code === "ViolatedBlockedRoad") return "a blocked road";
  if (code === "SeasonalClosure") return "a road that may be closed for the season";
  if (code.includes("TurnRestriction")) return "a turn trucks can't make";
  if (code.includes("ZoneRestriction")) return "an area trucks can't enter";
  if (code === "ViolatedAvoidTruckRoadType") return "a road trucks shouldn't use";
  if (code === "ViolatedEmergencyGate") return "an emergency gate";
  return "a road with truck limits";
}

/** The limits named in one notice, in plain English. */
function noticeLimits(notice: any): string[] {
  const details = Array.isArray(notice?.Details) ? notice.Details : [];
  const limits = details.flatMap((detail: any) => measuredLimits(detail?.ViolatedConstraints));
  return limits.length ? limits : [kindOfLimit(String(notice?.Code ?? ""))];
}

/** How safe one leg of a route is for the truck, from Amazon Location's notices for it. */
export function legSafety(notices: unknown): LegSafety {
  let status: LegSafety["status"] = "ok";
  const limits: string[] = [];
  for (const notice of Array.isArray(notices) ? notices : []) {
    const code = String((notice as any)?.Code ?? "");
    const breaks = BREAKS_A_LIMIT.has(code);
    if (!breaks && !MAY_BREAK_A_LIMIT.has(code)) continue;
    if (breaks) status = "unsafe";
    else if (status === "ok") status = "check";
    for (const limit of noticeLimits(notice)) if (!limits.includes(limit)) limits.push(limit);
  }
  return { status, limits: limits.slice(0, 3) };
}

/** "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
