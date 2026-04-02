import { z } from "zod";

// ─── Location Block ───────────────────────────────────────────────────────────

const LOCATION_TYPES = [
  "Business", "Residence", "Auction", "Port",
  "Repo Yard", "Dealer", "Auto Show", "Other",
] as const;

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
] as const;

export const locationBlockSchema = z.object({
  locationType:         z.enum(LOCATION_TYPES).optional(),
  companyName:          z.string().trim().max(100).optional(),
  contactName:          z.string().trim().max(100).optional(),
  email:                z.string().trim().email("Invalid email").optional().or(z.literal("")),
  phone:                z.string().trim().regex(/^\d{10}$/, "Phone must be exactly 10 digits").optional().or(z.literal("")),
  cellPhone:            z.string().trim().max(20).optional(),
  phoneExt:             z.string().trim().max(6).optional(),
  street:               z.string().trim().max(200).optional(),
  city:                 z.string().trim().min(2, "City is required").max(100),
  state:                z.enum(US_STATES),
  zip:                  z.string().trim().min(5, "ZIP code is required").max(10),
  country:              z.string().trim().length(2).default("US"),
  buyerReferenceNumber: z.string().trim().max(50).optional(),
  isTwicRequired:       z.boolean().default(false),
  notes:                z.string().trim().max(500).optional(),
});

// ─── Vehicle ──────────────────────────────────────────────────────────────────

const TRAILER_TYPES = [
  "open_3car_wedge", "open_2car", "5car_open", "9car_stinger", "7car_stinger",
  "enclosed_2car", "enclosed_3car", "flatbed", "dually_flatbed", "hotshot",
  "gooseneck", "lowboy", "step_deck", "rgn", "double_drop", "power_only", "other",
] as const;

export const loadVehicleSchema = z.object({
  hasVin:       z.boolean().default(false),
  vin:          z.string().trim().toUpperCase().max(17).optional(),
  vehicleType:  z.string().trim().max(50).optional(),
  year:         z.coerce.number().int().min(1900).max(new Date().getFullYear() + 1).optional(),
  make:         z.string().trim().max(50).optional(),
  model:        z.string().trim().max(50).optional(),
  color:        z.string().trim().max(50).optional(),
  trailerType:  z.enum(TRAILER_TYPES),
  condition:    z.enum(["Operable", "Inoperable"]).default("Operable"),
  oversized:    z.boolean().default(false),
  lotNumber:    z.string().trim().max(50).optional(),
  licensePlate: z.string().trim().toUpperCase().max(20).optional(),
  licenseState: z.string().trim().toUpperCase().max(2).optional(),
  carrierNotes: z.string().trim().max(500).optional(),
});

// ─── Dates ────────────────────────────────────────────────────────────────────

export const loadDatesSchema = z.object({
  firstAvailable:  z.coerce.date().optional(),
  expirationDate:  z.coerce.date().optional(),
  pickupDeadline:  z.coerce.date().optional(),
  deliveryDeadline:z.coerce.date().optional(),
  notes:           z.string().trim().max(500).optional(),
}).refine(
  (d) => {
    if (d.firstAvailable && d.deliveryDeadline) {
      return d.deliveryDeadline >= d.firstAvailable;
    }
    return true;
  },
  { message: "Delivery deadline must be on or after first available date" }
).refine(
  (d) => {
    if (d.firstAvailable && d.expirationDate) {
      return d.expirationDate >= d.firstAvailable;
    }
    return true;
  },
  { message: "Expiration date must be on or after first available date" }
);

// ─── Additional Info ──────────────────────────────────────────────────────────

export const loadAdditionalInfoSchema = z.object({
  notes:               z.string().trim().max(4000).optional(),
  instructions:        z.string().trim().max(4000).optional(),
  visibility:          z.enum(["public", "private"]).default("public"),
  internalLoadId:      z.string().trim().max(50).optional(),
  preDispatchNotes:    z.string().trim().max(4000).optional(),
  specialInstructions: z.string().trim().max(4000).optional(),
  loadSpecificTerms:   z.string().trim().max(500).optional(),
});

// ─── Contract ─────────────────────────────────────────────────────────────────

export const loadContractSchema = z.object({
  agreedToTerms: z.boolean(),
  signatureName: z.string().trim().max(200).optional(),
  signedAt:      z.coerce.date().optional(),
}).refine(
  (c) => !c.agreedToTerms || !!c.signatureName?.trim(),
  { message: "Signature name is required when terms are agreed", path: ["signatureName"] }
);

// ─── Create Load ──────────────────────────────────────────────────────────────

export const createLoadSchema = z.object({
  postType:         z.enum(["load-board", "assign-carrier"]).default("load-board"),
  pickupLocation:   locationBlockSchema,
  deliveryLocation: locationBlockSchema,
  vehicles:         z.array(loadVehicleSchema).max(12, "Maximum 12 vehicles per load").default([]),
  dates:            loadDatesSchema.optional(),
  additionalInfo:   loadAdditionalInfoSchema.optional(),
  contract:         loadContractSchema.optional(),
  // pricing.carrierPayAmount + copCodAmount accepted from client; miles/estimatedRate are server-computed
  pricing: z.object({
    carrierPayAmount: z.number().min(0).optional(),
    copCodAmount:     z.number().min(0).default(0),
  }).optional(),
});

export type CreateLoadInput = z.infer<typeof createLoadSchema>;

// ─── Calculate Rate (standalone endpoint) ─────────────────────────────────────

export const calculateRateSchema = z.object({
  pickupZip:  z.string().trim().min(5).max(10),
  deliveryZip:z.string().trim().min(5).max(10),
  vehicles:   z.array(z.object({
    trailerType: z.string(),
    condition:   z.enum(["Operable", "Inoperable"]),
  })).default([]),
});
