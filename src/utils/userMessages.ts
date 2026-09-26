import User from '../models/User.model';

/**
 * Plain-English messages shared by the Driver Tracker, Driver Portal,
 * Transportation and Inventory APIs. Rules for every user-facing error:
 *   - say what happened, why, and what to do next;
 *   - identify the record by its business number (load/vehicle), never by an
 *     internal id, email, phone number or storage key;
 *   - driver-facing messages refer to "Dispatch", not to named staff.
 */

export const LOAD_NOT_FOUND =
  "We couldn't find this load. It may have been deleted, or you may not have access to it. Refresh the page and try again.";

export const LOAD_UNAVAILABLE_FOR_DRIVER =
  'This load is no longer available. It may have been assigned to another driver or removed by Dispatch. Refresh your loads and try again.';

export const DRIVER_NOT_FOUND =
  "We couldn't find that driver, or their account is no longer active. Refresh the driver list and choose another driver.";

export const DRIVER_PROFILE_NOT_FOUND =
  "We couldn't find this driver's profile. The driver may not have finished setting it up yet.";

export const VEHICLE_NOT_FOUND =
  "We couldn't find this vehicle. It may have been sold, removed from inventory, or you may not have access to it. Refresh the page and try again.";

export const QUOTE_NOT_FOUND =
  "We couldn't find this transportation draft. It may have been deleted or converted into a load. Refresh the page and try again.";

export const DOCUMENT_NOT_FOUND =
  'This document is no longer available. It may have been replaced or removed.';

export const DOCUMENT_FILE_UNAVAILABLE =
  "The file for this document couldn't be opened. It may need to be uploaded again.";

export const INVALID_LINK =
  "This link doesn't point to a valid record. Go back and open it again from the list.";

export const SIGN_IN_AGAIN = 'Your session has ended. Please sign in again.';

export const SELECT_ORGANIZATION =
  'Select your organization first, then try again.';

/**
 * "Maria Santos (the dispatcher responsible for this load)" when the
 * responsible dispatcher is known, otherwise a generic phrase. Staff-facing
 * messages only — driver-facing messages must say "Dispatch".
 */
export async function responsibleDispatcherPhrase(load: any): Promise<{ phrase: string; name: string }> {
  const ownerId = load?.dispatchOwnerId;
  const owner: any = ownerId ? await User.findById(ownerId).select('name').lean() : null;
  const name = String(owner?.name ?? '').trim();
  return {
    name,
    phrase: name
      ? `${name} (the dispatcher responsible for this load)`
      : 'the dispatcher responsible for this load',
  };
}

const FIELD_LABELS: Record<string, string> = {
  pickupLocation: 'Pickup',
  deliveryLocation: 'Delivery',
  vehicles: 'Vehicle',
  trailerType: 'Trailer type',
  dates: 'Dates',
  pricing: 'Pricing',
  additionalInfo: 'Notes and visibility',
  contract: 'Contract',
  postType: 'Load type',
  pickupZip: 'Pickup ZIP',
  deliveryZip: 'Delivery ZIP',
};

/**
 * Turns validation issues into one readable sentence, naming the part of the
 * form each problem belongs to, e.g.
 * "Please fix the following: Pickup: City is required. Vehicle 2: Invalid year."
 */
export function describeValidationIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): string {
  const parts = issues.slice(0, 6).map((issue) => {
    const [first, second] = issue.path;
    const base = FIELD_LABELS[String(first ?? '')] ?? '';
    const label =
      base === 'Vehicle' && typeof second === 'number' ? `Vehicle ${second + 1}` : base;
    return label ? `${label}: ${issue.message}` : issue.message;
  });
  const unique = [...new Set(parts)];
  return `Please fix the following: ${unique.join('. ')}.`.replace(/\.\./g, '.');
}
