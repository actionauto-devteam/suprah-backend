jest.mock('../../src/models/DriverRequest.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverReviewEvent.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import {
  evaluateDriverVerificationEligibility,
  missingVerificationDetails,
} from '../../src/services/driverVerificationReview.service';

// A driver who signed up and was approved: the application asked for everything
// except the insurance details and the VIN.
const signedUp = {
  verificationStatus: 'under_review',
  firstName: 'Ana',
  lastName: 'Reyes',
  driversLicenseNumber: 'DL-123',
  licenseState: 'UT',
  licenseExpirationDate: new Date('2030-01-01T00:00:00Z'),
  ssnLast4: '1234',
  backgroundCheckConsent: true,
  verificationAgreement: true,
};

describe('missingVerificationDetails', () => {
  it('lists the details a newly approved driver still has to add', () => {
    expect(missingVerificationDetails(signedUp)).toEqual(['Insurance Provider', 'Insurance Policy Number', 'VIN']);
  });

  it('is empty once everything is filled in', () => {
    expect(
      missingVerificationDetails({ ...signedUp, insuranceProvider: 'Progressive', insurancePolicyNumber: 'POL-1', vin: '1HGCM82633A004352' }),
    ).toEqual([]);
  });

  it('treats blank text as missing and lists everything for an empty profile', () => {
    expect(missingVerificationDetails({ ...signedUp, insuranceProvider: '  ', insurancePolicyNumber: 'POL-1', vin: 'X' })).toEqual([
      'Insurance Provider',
    ]);
    expect(missingVerificationDetails(null)).toHaveLength(10);
  });

  it('matches what the approval check calls incomplete', () => {
    const blockers = evaluateDriverVerificationEligibility(signedUp).blockers.filter((item) => item.endsWith(' is incomplete'));
    expect(blockers).toEqual(missingVerificationDetails(signedUp).map((label) => `${label} is incomplete`));
  });
});
