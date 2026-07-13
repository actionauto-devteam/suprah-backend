
const POST_DISPATCH_STATUSES = new Set(["Assigned", "In-Transit", "Delivered"]);

function maskLocation(loc: Record<string, unknown>): Record<string, unknown> {
  return {
    city:    loc.city,
    state:   loc.state,
    zip:     loc.zip,
    country: loc.country,
  };
}

export function maskLoadForDriver(load: Record<string, unknown>): Record<string, unknown> {
  const status         = load.status as string;
  const isPostDispatch = POST_DISPATCH_STATUSES.has(status);

  const masked: Record<string, unknown> = { ...load };

  if (!isPostDispatch) {
    if (masked.pickupLocation)
      masked.pickupLocation = maskLocation(masked.pickupLocation as Record<string, unknown>);
    if (masked.deliveryLocation)
      masked.deliveryLocation = maskLocation(masked.deliveryLocation as Record<string, unknown>);
  }

  if (masked.pricing && typeof masked.pricing === "object") {
    const p = masked.pricing as Record<string, unknown>;
    masked.pricing = {
      miles:         p.miles,
      estimatedRate: p.estimatedRate,
    };
  }

  delete masked.contract;

  if (masked.additionalInfo && typeof masked.additionalInfo === "object") {
    const info = { ...(masked.additionalInfo as Record<string, unknown>) };
    delete info.preDispatchNotes;
    delete info.internalLoadId;
    delete info.loadSpecificTerms;
    masked.additionalInfo = info;
  }

  return masked;
}
