import { z } from "zod";

// ─── Shared pieces ────────────────────────────────────────────────────────────

const zipSchema = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, "ZIP code must be 5 digits");

const locationBlockSchema = z.object({
  name: z.string().trim().max(160).optional().or(z.literal("")),
  address: z.string().trim().min(1, "Address is required").max(240),
  city: z.string().trim().min(1, "City is required").max(120),
  state: z.string().trim().min(2, "State is required").max(40),
  zip: zipSchema,
  // ── NEW: LocationFields additions (country / ext / per-location notes) ──
  // Must exist here AND in Load.model.ts's locationSchema, or zod's strip
  // mode / Mongoose strict mode silently discards them (same failure mode
  // as dates.notes and pricing.pricePerMile).
  country: z.string().trim().max(3).optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  phoneExt: z.string().trim().max(6).optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email address").optional().or(z.literal("")),
  contactName: z.string().trim().max(120).optional().or(z.literal("")),
  locationType: z
    .enum(["dealership", "auction", "residence", "business", "port", "other"])
    .optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  // Exact spot picked on the map (Create Load). Empty values mean "no pin"
  // and are dropped, so a saved load never carries a blank pin.
  coordinates: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  placeId: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((value) => value || undefined),
});

const vehicleConditionSchema = z.enum(["Operable", "Inoperable"]);

const loadVehicleSchema = z.object({
  vehicleId: z.string().trim().optional(),
  vin: z
    .string()
    .trim()
    .max(17, "A VIN can be at most 17 characters")
    .optional()
    .or(z.literal("")),
  year: z.coerce
    .number()
    .int()
    .min(1900, "Enter a valid year")
    .max(2100, "Enter a valid year")
    .optional(),
  make: z.string().trim().max(80).optional().or(z.literal("")),
  model: z.string().trim().max(80).optional().or(z.literal("")),
  color: z.string().trim().max(60).optional().or(z.literal("")),
  condition: vehicleConditionSchema.default("Operable"),
  // Inspect step — set via the dedicated inspection-photo upload endpoint,
  // not the create/update body, but must round-trip through updateLoad.
  inspectionPhotoUrl: z.string().trim().optional().or(z.literal("")),
});

export const TRAILER_TYPES = [
  "open_3car_wedge",
  "open_2car",
  "enclosed_2car",
  "enclosed_3car",
  "flatbed",
  "hotshot",
  "dually_flatbed",
  "gooseneck",
  "lowboy",
  "step_deck",
  "9car_stinger",
  "7car_stinger",
  "5car_open",
  "rgn",
  "double_drop",
  "power_only",
  "other",
] as const;

// Load schedule dates are calendar days (YYYY-MM-DD). A value with a time and
// time zone could otherwise land on a different day once stored. The UTC
// midnight form the API itself returns (…T00:00:00.000Z) is also accepted, so
// re-saving a loaded form works; both are stored as the plain day.
const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/;
const businessDateSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value === "") return true;
    const match = value.match(BUSINESS_DATE_PATTERN);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, "Enter the date as a calendar day, for example 2026-09-04.")
  .transform((value) => (value === "" ? value : value.slice(0, 10)));

const datesSchema = z
  .object({
    firstAvailable: businessDateSchema.optional(),
    pickupDeadline: businessDateSchema.optional(),
    deliveryDeadline: businessDateSchema.optional(),
    // Date Notes textarea from DatesSection — without this, zod's default
    // strip mode silently discards it
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
  })
  .optional();

const additionalInfoSchema = z
  .object({
    visibility: z.enum(["public", "private"]).default("public"),
    notes: z.string().trim().max(4000).optional().or(z.literal("")),
    instructions: z.string().trim().max(4000).optional().or(z.literal("")),
    referenceNumber: z.string().trim().max(120).optional().or(z.literal("")),
  })
  .optional();

// ── Freehand e-signature from the SignaturePad ──
// PNG data URL. 200k ceiling mirrors the User model field. Shared shape
// between the dispatcher's contract (optional — enforced client-side +
// by validateContract()) and the driver's signature (required — see
// driverSignSchema below, no signing without both fields present).
const signatureDataUrlSchema = z
  .string()
  .trim()
  .max(200_000, "Your signature is too large to save. Clear the signature box and sign again.")
  .refine(
    (v: string) => v === "" || v.startsWith("data:image/"),
    "Your signature couldn't be read. Clear the signature box and sign again.",
  );

const contractSchema = z
  .object({
    agreedToTerms: z.boolean().default(false),
    signatureDataUrl: signatureDataUrlSchema.optional().or(z.literal("")).nullable(),
    signerName: z.string().trim().max(160).optional().or(z.literal("")),
  })
  .optional();

// ─── Driver contract signature (accept / request load) ───────────────────────
// Required, not optional — a driver cannot accept or request a load without
// agreeing to terms and providing a signature.
export const driverSignSchema = z.object({
  agreedToTerms: z.literal(true, "Check the box to agree to the transport terms before signing."),
  signatureDataUrl: signatureDataUrlSchema.min(1, "Sign in the signature box before continuing."),
  signerName: z.string().trim().max(160).optional().or(z.literal("")),
});

export type DriverSignInput = z.infer<typeof driverSignSchema>;

const pricingInputSchema = z
  .object({
    // ── NEW: dispatcher's $/mi rate from the Create Load Pricing step ──
    // Kept in two-way sync with carrierPayAmount on the frontend
    // (pay = pricePerMile × miles) and persisted on pricing.pricePerMile.
    // Without this line, zod's default strip mode silently discards the
    // field before the controller sees it — the same failure mode the
    // dates.notes field hit. Ceiling of 1,000 $/mi is a sanity bound:
    // carrierPayAmount caps at $1M and no real route is under ~1,000 mi
    // at that price.
    pricePerMile: z.coerce.number().min(0).max(1_000).optional(),
    carrierPayAmount: z.coerce.number().min(0).max(1_000_000).optional(),
    copCodAmount: z.coerce.number().min(0).max(1_000_000).optional(),
    isPricingEnabled: z.boolean().optional(),
    isVisibleToDriver: z.boolean().optional(),
  })
  .optional();

// ─── Create Load ──────────────────────────────────────────────────────────────
// RAISED: vehicles max was 9 — the platform-wide limit is now 20 for BOTH
// load-board and assign-carrier workflows. This must match:
//   · MAX_VEHICLES in components/create-load/types.ts (frontend)
//   · MAX_VEHICLES_PER_LOAD in controllers/load.controller.ts (backend)

export const MAX_VEHICLES_PER_LOAD = 20;

export const createLoadSchema = z
  .object({
    postType: z.enum(["load-board", "assign-carrier"], "Choose Load Board or Assign Carrier."),
    pickupLocation: locationBlockSchema,
    deliveryLocation: locationBlockSchema,
    vehicles: z
      .array(loadVehicleSchema)
      .min(1, "Add at least one vehicle to the load.")
      .max(
        MAX_VEHICLES_PER_LOAD,
        `A load can include at most ${MAX_VEHICLES_PER_LOAD} vehicles`,
      ),
    trailerType: z.enum(TRAILER_TYPES, "Choose a trailer type from the list."),
    dates: datesSchema,
    additionalInfo: additionalInfoSchema,
    contract: contractSchema,
    pricing: pricingInputSchema,
  })
  .superRefine((value, ctx) => {
    if (value.postType !== "assign-carrier") return;
    if (value.pricing?.isPricingEnabled === false) return;

    const totalDriverPay = value.pricing?.carrierPayAmount;
    if (
      typeof totalDriverPay !== "number" ||
      !Number.isFinite(totalDriverPay) ||
      totalDriverPay <= 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pricing", "carrierPayAmount"],
        message: "Enter a Total Driver Pay greater than $0, or turn off Include Pricing.",
      });
    }
  });

export type CreateLoadInput = z.infer<typeof createLoadSchema>;

// ─── Edit Load ────────────────────────────────────────────────────────────────
// Same field rules as Create Load, every field optional, and nothing else
// accepted. expectedUpdatedAt is the version of the load the dispatcher
// started editing from, so a save never overwrites a change made meanwhile.

const additionalInfoUpdateSchema = z
  .object({
    // No default here: leaving visibility out keeps the load's current setting.
    visibility: z.enum(["public", "private"]).optional(),
    notes: z.string().trim().max(4000).optional().or(z.literal("")),
    instructions: z.string().trim().max(4000).optional().or(z.literal("")),
    referenceNumber: z.string().trim().max(120).optional().or(z.literal("")),
  })
  .optional();

export const updateLoadSchema = z
  .object({
    postType: z.enum(["load-board", "assign-carrier"], "Choose Load Board or Assign Carrier.").optional(),
    pickupLocation: locationBlockSchema.optional(),
    deliveryLocation: locationBlockSchema.optional(),
    vehicles: z
      .array(loadVehicleSchema)
      .min(1, "Add at least one vehicle to the load.")
      .max(MAX_VEHICLES_PER_LOAD, `A load can include at most ${MAX_VEHICLES_PER_LOAD} vehicles`)
      .optional(),
    trailerType: z.enum(TRAILER_TYPES, "Choose a trailer type from the list.").optional(),
    dates: datesSchema,
    additionalInfo: additionalInfoUpdateSchema,
    contract: contractSchema,
    pricing: pricingInputSchema,
    // Echoing the current status is allowed; changing it is refused later.
    status: z.string().trim().max(40).optional(),
    expectedUpdatedAt: z
      .string("This edit form is out of date. Refresh the load and make your change again.")
      .trim()
      .refine(
        (value) => Number.isFinite(new Date(value).getTime()),
        "This edit form is out of date. Refresh the load and make your change again.",
      ),
  })
  // Unknown fields are refused (the controller words that message).
  .strict();

export type UpdateLoadInput = z.infer<typeof updateLoadSchema>;

// ─── Rate Calculation ─────────────────────────────────────────────────────────

export const calculateRateSchema = z.object({
  pickupZip: zipSchema,
  deliveryZip: zipSchema,
  trailerType: z.enum(TRAILER_TYPES),
  vehicles: z
    .array(z.object({ condition: vehicleConditionSchema }))
    .min(1)
    .max(MAX_VEHICLES_PER_LOAD),
});

export type CalculateRateInput = z.infer<typeof calculateRateSchema>;