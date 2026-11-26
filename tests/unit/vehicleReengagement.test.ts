const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.VEHICLE_REENGAGEMENT_CLASSIFIER_TIMEOUT_MS = '50';

const mockOrganizationFindById = jest.fn();
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrganizationFindById },
}));

import {
  normalizeToken,
  matchesVehicle,
  buildReengagementText,
  generateReengagementMessage,
} from '../../src/services/vehicleReengagement.service';

describe('normalizeToken', () => {
  it('lowercases, trims, and strips punctuation', () => {
    expect(normalizeToken('  Chevy-Silverado!! ')).toBe('chevy silverado');
  });

  it('handles undefined/empty input', () => {
    expect(normalizeToken(undefined)).toBe('');
    expect(normalizeToken('')).toBe('');
  });
});

describe('matchesVehicle', () => {
  const vehicle = { year: 2022, make: 'Toyota', modelName: 'Camry SE' } as any;

  it('matches exact year/make/model', () => {
    expect(matchesVehicle({ year: '2022', make: 'Toyota', model: 'Camry SE' }, vehicle)).toBe(true);
  });

  it('matches a trim-variant substring both directions', () => {
    expect(matchesVehicle({ year: '2022', make: 'Toyota', model: 'Camry' }, vehicle)).toBe(true);
  });

  it('rejects a year mismatch', () => {
    expect(matchesVehicle({ year: '2021', make: 'Toyota', model: 'Camry' }, vehicle)).toBe(false);
  });

  it('rejects a make mismatch', () => {
    expect(matchesVehicle({ year: '2022', make: 'Honda', model: 'Camry' }, vehicle)).toBe(false);
  });

  it('requires an exact match for short model strings instead of a substring hit', () => {
    const shortModelVehicle = { year: 2022, make: 'Kia', modelName: 'K5' } as any;
    expect(matchesVehicle({ year: '2022', make: 'Kia', model: 'K' }, shortModelVehicle)).toBe(false);
    expect(matchesVehicle({ year: '2022', make: 'Kia', model: 'K5' }, shortModelVehicle)).toBe(true);
  });

  it('rejects when the lead vehicle year is not a valid number', () => {
    expect(matchesVehicle({ year: 'unknown', make: 'Toyota', model: 'Camry' }, vehicle)).toBe(false);
  });
});

describe('buildReengagementText (the approved re-engagement wording)', () => {
  const lead = { _id: 'lead-1', firstName: 'Jordan' };
  const vehicle = { _id: 'vehicle-1', organizationId: 'org-1', year: 2021, make: 'Toyota', modelName: 'Camry', trim: 'SE', vdpUrl: 'https://www.example.com/inventory/2021-toyota-camry-se' } as any;

  it('uses the approved wording with the name, agent, vehicle and link', () => {
    expect(buildReengagementText(lead, vehicle, 'Anna')).toBe(
      'Hey Jordan, this is Anna from Action Auto Sales and Finance. The 2021 Toyota Camry SE has completed the reconditioning process and is now ready for sale. Please book a test drive or schedule an appointment today! Click here for vehicle information: https://www.example.com/inventory/2021-toyota-camry-se',
    );
  });

  it.each([undefined, '', '   ', 'Unknown', 'customer', 'jordan@example.com', 'Lead 4421', 'A very long name that clearly is not a first name'])(
    'says "Hey there" when the first name is %p',
    (firstName) => {
      expect(buildReengagementText({ firstName }, vehicle, 'Anna').startsWith('Hey there, this is Anna from Action Auto Sales and Finance.')).toBe(true);
    },
  );

  it.each([undefined, '', 'not a link', 'javascript:alert(1)', 'https://example.com/a b', `https://example.com/${'x'.repeat(300)}`])(
    'leaves the link sentence out when the vehicle link is %p',
    (vdpUrl) => {
      const text = buildReengagementText(lead, { ...vehicle, vdpUrl }, 'Anna');
      expect(text).not.toContain('Click here');
      expect(text.endsWith('Please book a test drive or schedule an appointment today!')).toBe(true);
    },
  );

  it('still reads well when the vehicle has no details', () => {
    expect(buildReengagementText(lead, { organizationId: 'org-1' } as any, 'Anna')).toContain('The vehicle has completed the reconditioning process');
  });
});

describe('generateReengagementMessage', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockOrganizationFindById.mockReset();
    mockOrganizationFindById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Action Auto Utah', metadata: { aiAgentName: 'Anna' } }) }),
    });
  });

  it('uses the AI agent name from settings and does not ask the AI to write anything', async () => {
    const result = await generateReengagementMessage({ firstName: 'Jordan' }, { organizationId: 'org-1', year: 2022, make: 'Toyota', modelName: 'Camry' } as any);

    expect(result.text).toBe('Hey Jordan, this is Anna from Action Auto Sales and Finance. The 2022 Toyota Camry has completed the reconditioning process and is now ready for sale. Please book a test drive or schedule an appointment today!');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
