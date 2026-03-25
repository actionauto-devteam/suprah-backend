import { z } from "zod";

// ─── Location Block ───────────────────────────────────────────────────────────

const LOCATION_TYPES = [
  "Business",
  "Residence",
  "Auction",
  "Port",
  "Repo Yard",
  "Dealer",
  "Auto Show",
  "Other",
] as const;

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
] as const;

export const locationBlockSchema = z.object({
  locationType: z.enum(LOCATION_TYPES).optional(),
  companyName:  z.string().trim().max(100).optional(),
  contactName:  z.string().trim().max(100).optional(),
  street:       z.string().trim().min(3,  "Street address is required").max(200),
  city:         z.string().trim().min(2,  "City is required").max(100),
  state:        z.enum(US_STATES),
  zip:          z.string().trim().min(5,  "ZIP code is required").max(10),
  country:      z.string().trim().length(2).default("US"),
  phone:        z.string().trim().max(20).optional(),
  phoneExt:     z.string().trim().max(6).optional(),
  notes:        z.string().trim().max(500).optional(),
});

// ─── Create Load ──────────────────────────────────────────────────────────────

export const createLoadSchema = z.object({
  postType:         z.enum(["load-board", "assign-carrier"]).default("load-board"),
  pickupLocation:   locationBlockSchema,
  deliveryLocation: locationBlockSchema,
});

export type CreateLoadInput = z.infer<typeof createLoadSchema>;
