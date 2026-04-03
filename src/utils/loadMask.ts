// utils/loadMask.ts
// Role-aware field masking for Load responses.
//
// Drivers see city/state/zip only when load is pre-dispatch (Posted/Draft).
// Full address is revealed once the load is Assigned, In-Transit, or Delivered.
// Financial and contract details are never shown to drivers.

const POST_DISPATCH_STATUSES = new Set(["Assigned", "In-Transit", "Delivered"]);

function maskLocation(loc: Record<string, unknown>): Record<string, unknown> {
  return {
    // Reveal only enough to plan routing — no street, contact, or company
    city:    loc.city,
    state:   loc.state,
    zip:     loc.zip,
    country: loc.country,
  };
}

/**
 * Strip sensitive fields from a load document for driver-role responses.
 * Accepts a plain object (from .lean() or toObject()).
 */
export function maskLoadForDriver(load: Record<string, unknown>): Record<string, unknown> {
  const status         = load.status as string;
  const isPostDispatch = POST_DISPATCH_STATUSES.has(status);

  const masked: Record<string, unknown> = { ...load };

  // ── Address masking ──────────────────────────────────────────────────────────
  if (!isPostDispatch) {
    if (masked.pickupLocation)
      masked.pickupLocation = maskLocation(masked.pickupLocation as Record<string, unknown>);
    if (masked.deliveryLocation)
      masked.deliveryLocation = maskLocation(masked.deliveryLocation as Record<string, unknown>);
  }

  // ── Financial details — drivers see miles only, not pay amounts ─────────────
  if (masked.pricing && typeof masked.pricing === "object") {
    const p = masked.pricing as Record<string, unknown>;
    masked.pricing = {
      miles:         p.miles,
      estimatedRate: p.estimatedRate,
      // carrierPayAmount, copCodAmount, balanceAmount are stripped
    };
  }

  // ── Contract — internal document, not for drivers ───────────────────────────
  delete masked.contract;

  // ── Admin-only additionalInfo fields ────────────────────────────────────────
  if (masked.additionalInfo && typeof masked.additionalInfo === "object") {
    const info = { ...(masked.additionalInfo as Record<string, unknown>) };
    delete info.preDispatchNotes;
    delete info.internalLoadId;
    delete info.loadSpecificTerms;
    masked.additionalInfo = info;
  }

  return masked;
}
