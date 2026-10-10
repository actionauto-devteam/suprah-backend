const mockFindOne = jest.fn();
const mockReviewEventCreate = jest.fn();
const mockCreateNotification = jest.fn();

jest.mock('../../src/models/DriverProfile.model', () => {
  const actual = jest.requireActual('../../src/models/DriverProfile.model');
  return { __esModule: true, ...actual, default: { findOne: mockFindOne } };
});
jest.mock('../../src/models/DriverRequest.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverReviewEvent.model', () => ({
  __esModule: true,
  default: { create: mockReviewEventCreate },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: mockCreateNotification },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { approvedCredentialExpiryUpdates } from '../../src/models/DriverProfile.model';
import { reviewDriverDocument } from '../../src/services/driverVerificationReview.service';

const OLD_CDL = new Date('2026-10-07T00:00:00Z');
const RENEWED_CDL = new Date('2030-07-19T00:00:00Z');

// A renewed CDL, medical card or insurance document, once approved, becomes the
// credential date Dispatch sees, so the "expired" warning clears.
describe('approvedCredentialExpiryUpdates', () => {
  it('takes the later date from an approved renewal', () => {
    expect(
      approvedCredentialExpiryUpdates({
        licenseExpirationDate: OLD_CDL,
        documents: [{ type: 'drivers_license', reviewStatus: 'approved', expiresAt: RENEWED_CDL }],
      }),
    ).toEqual({ licenseExpirationDate: RENEWED_CDL });
  });

  it('waits for approval: pending and rejected renewals change nothing', () => {
    expect(
      approvedCredentialExpiryUpdates({
        licenseExpirationDate: OLD_CDL,
        documents: [
          { type: 'drivers_license', reviewStatus: 'pending', expiresAt: RENEWED_CDL },
          { type: 'drivers_license', reviewStatus: 'rejected', expiresAt: RENEWED_CDL },
        ],
      }),
    ).toEqual({});
  });

  it('never moves a stored date backwards', () => {
    expect(
      approvedCredentialExpiryUpdates({
        licenseExpirationDate: RENEWED_CDL,
        documents: [{ type: 'drivers_license', reviewStatus: 'approved', expiresAt: OLD_CDL }],
      }),
    ).toEqual({});
  });

  it('fills an empty stored date, and uses the latest of several approved documents', () => {
    const medical = new Date('2028-01-01T00:00:00Z');
    expect(
      approvedCredentialExpiryUpdates({
        documents: [
          { type: 'drivers_license', reviewStatus: 'approved', expiresAt: OLD_CDL },
          { type: 'drivers_license', reviewStatus: 'approved', expiresAt: RENEWED_CDL },
          { type: 'medical_card', reviewStatus: 'approved', expiresAt: medical },
        ],
      }),
    ).toEqual({ licenseExpirationDate: RENEWED_CDL, medicalCardExpirationDate: medical });
  });

  it('maps insurance, and ignores documents that are not one of the three credentials', () => {
    const insurance = new Date('2029-05-23T00:00:00Z');
    expect(
      approvedCredentialExpiryUpdates({
        documents: [
          { type: 'insurance_certificate', reviewStatus: 'approved', expiresAt: insurance },
          { type: 'vehicle_registration', reviewStatus: 'approved', expiresAt: RENEWED_CDL },
          { type: 'constructor', reviewStatus: 'approved', expiresAt: RENEWED_CDL },
          { type: 'drivers_license', reviewStatus: 'approved' },
        ],
      }),
    ).toEqual({ insuranceExpirationDate: insurance });
  });
});

describe('reviewDriverDocument and renewed credentials', () => {
  const uploadedAt = new Date('2026-10-10T08:00:00Z');

  const profileWithRenewedCdl = () => ({
    licenseExpirationDate: OLD_CDL,
    verificationStatus: 'verified',
    verificationAgreement: true,
    documents: [
      {
        _id: 'doc-1',
        type: 'drivers_license',
        label: "Commercial Driver's License (CDL)",
        uploadedAt,
        expiresAt: RENEWED_CDL,
        verified: false,
        reviewStatus: 'pending',
      },
    ],
    save: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    mockFindOne.mockReset();
    mockReviewEventCreate.mockReset().mockResolvedValue(undefined);
    mockCreateNotification.mockReset().mockResolvedValue(undefined);
  });

  it('approving the renewed CDL updates the CDL date Dispatch sees', async () => {
    const profile = profileWithRenewedCdl();
    mockFindOne.mockResolvedValue(profile);

    await reviewDriverDocument({
      driverId: 'driver-1',
      documentId: 'doc-1',
      reviewer: { _id: 'reviewer-1' },
      decision: 'approved',
      expectedUploadedAt: uploadedAt,
    });

    expect(profile.licenseExpirationDate).toEqual(RENEWED_CDL);
    expect(profile.documents[0].reviewStatus).toBe('approved');
    expect(profile.save).toHaveBeenCalledTimes(1);
  });

  it('rejecting the renewal keeps the old date', async () => {
    const profile = profileWithRenewedCdl();
    mockFindOne.mockResolvedValue(profile);

    await reviewDriverDocument({
      driverId: 'driver-1',
      documentId: 'doc-1',
      reviewer: { _id: 'reviewer-1' },
      decision: 'rejected',
      reason: 'Blurry photo',
      expectedUploadedAt: uploadedAt,
    });

    expect(profile.licenseExpirationDate).toEqual(OLD_CDL);
    expect(profile.save).toHaveBeenCalledTimes(1);
  });
});
