import User from '../models/User.model';

/**
 * Plain-English messages shared by the Driver Tracker, Driver Portal,
 * Transportation and Inventory APIs. Rules for every user-facing error:
 *   - say what happened, why, and what to do next;
 *   - identify the record by its business number (load/vehicle), never by an
 *     internal id, email, phone number or storage key;
 *   - driver-facing messages refer to "Dispatch", not to named staff.
 */

/** Where drivers and other users without an organization admin get help. */
export const SUPPORT_EMAIL = 'support@suprahai.com';

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

/** The words people see on the forms, for the fields the APIs check. */
const FIELD_NAMES: Record<string, string> = {
  // Loads
  postType: 'load type',
  trailerType: 'trailer type',
  vehicles: 'vehicles',
  address: 'street address',
  city: 'city',
  state: 'state',
  zip: 'ZIP code',
  country: 'country',
  phone: 'phone number',
  phoneExt: 'phone extension',
  email: 'email address',
  contactName: 'contact name',
  locationType: 'location type',
  notes: 'notes',
  coordinates: 'map pin',
  lat: 'map pin',
  lng: 'map pin',
  placeId: 'map location',
  vin: 'VIN',
  year: 'year',
  make: 'make',
  model: 'model',
  color: 'color',
  condition: 'condition',
  inspectionPhotoUrl: 'inspection photo',
  firstAvailable: 'first available date',
  pickupDeadline: 'pickup deadline',
  deliveryDeadline: 'delivery deadline',
  visibility: 'visibility',
  instructions: 'instructions',
  referenceNumber: 'reference number',
  agreedToTerms: 'agreement to the transport terms',
  signatureDataUrl: 'signature',
  signerName: 'signer name',
  pricePerMile: 'price per mile',
  carrierPayAmount: 'carrier pay',
  copCodAmount: 'COP/COD amount',
  pickupZip: 'pickup ZIP code',
  deliveryZip: 'delivery ZIP code',
  // Accounts
  name: 'name',
  password: 'password',
  newPassword: 'new password',
  otp: 'code',
  dealershipName: 'dealership name',
  dealershipSlug: 'dealership web address',
  organizationId: 'organization',
  inviteToken: 'invite link',
  role: 'account type',
  // Driver profile
  maxVehicleCapacity: 'number of vehicles your trailer carries',
  serviceRadius: 'service radius',
  availableDays: 'work days',
  preferredRoutes: 'preferred routes',
  homeBase: 'home base',
  licenseExpirationDate: 'CDL expiration date',
  medicalCardExpirationDate: 'medical card expiration date',
  insuranceExpirationDate: 'insurance expiration date',
  driversLicenseNumber: 'CDL number',
  licenseState: 'license state',
  ssnLast4: 'last 4 digits of the SSN',
};

const humanizeKey = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * The field a validation path points to, in the form's words, e.g.
 * ["pickupLocation", "zip"] -> "Pickup ZIP code", ["vehicles", 1, "year"] -> "Vehicle 2 year".
 */
export function fieldLabelForPath(path: ReadonlyArray<PropertyKey>): string {
  const keys = path.filter((part): part is string => typeof part === 'string' && !/^\d+$/.test(part));
  const index = path.find((part): part is number => typeof part === 'number' || (typeof part === 'string' && /^\d+$/.test(part)));
  const leaf = keys[keys.length - 1];
  const leafName = leaf ? FIELD_NAMES[leaf] ?? humanizeKey(leaf) : '';

  if (keys[0] === 'pickupLocation' || keys[0] === 'deliveryLocation') {
    const where = keys[0] === 'pickupLocation' ? 'Pickup' : 'Delivery';
    if (keys.length === 1) return `${where} location`;
    return `${where} ${leaf === 'name' ? 'location name' : leafName}`;
  }
  if (keys[0] === 'vehicles') {
    const vehicle = index !== undefined ? `Vehicle ${Number(index) + 1}` : 'Vehicles';
    return keys.length > 1 ? `${vehicle} ${leafName}` : vehicle;
  }
  return capitalize(leafName);
}

// The validation library's own wording ("Invalid input: expected string,
// received undefined", "Too big: expected number to be <=1000") is replaced;
// messages a schema writes for people are kept.
const LIBRARY_DEFAULT_MESSAGE = /^(Invalid( input| option| string| email| value| format| date| number| key| element| union)?\b|Too (small|big)\b|Unrecognized key)/i;

type ValidationIssue = {
  path: PropertyKey[];
  message: string;
  code?: string;
  expected?: string;
  origin?: string;
  format?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
};

function plainIssue(issue: ValidationIssue, label: string): string {
  const field = label || 'This field';
  const lower = label ? label[0].toLowerCase() + label.slice(1) : 'value';
  const min = Number(issue.minimum);
  const max = Number(issue.maximum);
  switch (issue.code) {
    case 'invalid_type':
      if (/received (undefined|null)\s*$/i.test(issue.message)) {
        return issue.expected === 'array' ? `${field}: add at least one.` : `${field} is missing.`;
      }
      if (issue.expected === 'int') return `${field} must be a whole number.`;
      if (issue.expected === 'number') return `${field} must be a number.`;
      if (issue.expected === 'object') return `${field} is missing or incomplete.`;
      if (issue.expected === 'array') return `${field} must be a list.`;
      if (issue.expected === 'boolean') return `${field} must be yes or no.`;
      return `${field} isn't valid.`;
    case 'too_small':
      if (issue.origin === 'string') return min <= 1 ? `${field} is missing.` : `${field} must be at least ${min} characters.`;
      if (issue.origin === 'array') return `${field}: add at least ${min}.`;
      return min === 0 ? `${field} can't be negative.` : `${field} must be at least ${min}.`;
    case 'too_big':
      if (issue.origin === 'string') return `${field} can be at most ${max} characters.`;
      if (issue.origin === 'array') return `${field}: at most ${max} allowed.`;
      return `${field} can be at most ${max}.`;
    case 'invalid_value':
      return `Choose a valid ${lower}.`;
    case 'invalid_format':
      return issue.format === 'email' ? `Enter a valid ${label ? lower : 'email address'}.` : `${field} isn't in the right format.`;
    case 'unrecognized_keys':
      return "This form includes something that can't be saved here. Refresh the page and try again.";
    default:
      return `${field} isn't valid.`;
  }
}

/**
 * Turns validation issues into one readable sentence, naming the part of the
 * form each problem belongs to, e.g.
 * "Please fix the following: Pickup: City is required. Vehicle 2 year must be a number."
 */
export function describeValidationIssues(issues: ValidationIssue[]): string {
  const parts = issues.slice(0, 6).map((issue) => {
    if (LIBRARY_DEFAULT_MESSAGE.test(issue.message ?? '')) {
      return plainIssue(issue, fieldLabelForPath(issue.path ?? []));
    }
    const [first, second] = issue.path ?? [];
    const base = FIELD_LABELS[String(first ?? '')] ?? '';
    const label =
      base === 'Vehicle' && typeof second === 'number' ? `Vehicle ${second + 1}` : base;
    return label ? `${label}: ${issue.message}` : issue.message;
  });
  const unique = [...new Set(parts.map((part) => part.replace(/\.?\s*$/, '.')))];
  return `Please fix the following: ${unique.join(' ')}`;
}
