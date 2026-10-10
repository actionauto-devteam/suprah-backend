const mockVehicleFindOne = jest.fn();
const mockVehicleFind = jest.fn();

jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findOne: mockVehicleFindOne, find: mockVehicleFind },
}));

import { resolveVehicleContextForLead, UNMAPPED_LEAD_LOCATION_LABEL } from '../../src/services/leadLocation.service';

function selectLean(result: unknown) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) };
}

function selectLimitLean(result: unknown) {
  return {
    select: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
    }),
  };
}

describe('resolveVehicleContextForLead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves via an exact VIN match, taking priority even when a different vehicle would also fuzzy-match', async () => {
    mockVehicleFindOne.mockReturnValue(selectLean({ _id: 'vin-match-id', dealerCity: 'Lehi' }));
    mockVehicleFind.mockReturnValue(selectLimitLean([{ _id: 'wrong-fuzzy-match', make: 'Toyota', modelName: 'Camry', dealerCity: 'Orem' }]));

    const result = await resolveVehicleContextForLead('org-1', {
      vin: '1fake vin123',
      year: '2024',
      make: 'Toyota',
      model: 'Camry',
    });

    expect(mockVehicleFindOne).toHaveBeenCalledWith({ organizationId: 'org-1', vin: '1FAKE VIN123' });
    expect(mockVehicleFind).not.toHaveBeenCalled();
    expect(result).toEqual({ vehicleId: 'vin-match-id', location: 'Lehi' });
  });

  it('falls back to matchesVehicle (year+make+model) when no VIN is provided', async () => {
    mockVehicleFind.mockReturnValue(
      selectLimitLean([
        { _id: 'no-match', year: 2024, make: 'Ford', modelName: 'F-150', dealerCity: 'Orem' },
        { _id: 'fuzzy-match-id', year: 2024, make: 'Toyota', modelName: 'Camry SE', dealerCity: 'Lehi' },
      ]),
    );

    const result = await resolveVehicleContextForLead('org-1', { year: '2024', make: 'Toyota', model: 'Camry' });

    expect(mockVehicleFindOne).not.toHaveBeenCalled();
    expect(mockVehicleFind).toHaveBeenCalledWith({ organizationId: 'org-1', year: 2024 });
    expect(result).toEqual({ vehicleId: 'fuzzy-match-id', location: 'Lehi' });
  });

  it('falls back to matchesVehicle when a VIN was provided but not found', async () => {
    mockVehicleFindOne.mockReturnValue(selectLean(null));
    mockVehicleFind.mockReturnValue(selectLimitLean([{ _id: 'fuzzy-match-id', year: 2023, make: 'Honda', modelName: 'Civic', dealerCity: 'Provo' }]));

    const result = await resolveVehicleContextForLead('org-1', {
      vin: 'UNKNOWNVIN',
      year: '2023',
      make: 'Honda',
      model: 'Civic',
    });

    expect(result).toEqual({ vehicleId: 'fuzzy-match-id', location: 'Provo' });
  });

  it('returns null when nothing matches', async () => {
    mockVehicleFind.mockReturnValue(selectLimitLean([]));

    const result = await resolveVehicleContextForLead('org-1', { year: '2024', make: 'Toyota', model: 'Camry' });

    expect(result).toBeNull();
  });

  it('returns null with no lookups at all when the descriptor has no VIN and no usable year/make/model', async () => {
    const result = await resolveVehicleContextForLead('org-1', {});

    expect(mockVehicleFindOne).not.toHaveBeenCalled();
    expect(mockVehicleFind).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('resolves a match with an undefined location when the vehicle has no dealerCity on file', async () => {
    mockVehicleFindOne.mockReturnValue(selectLean({ _id: 'vin-match-id', dealerCity: undefined }));

    const result = await resolveVehicleContextForLead('org-1', { vin: 'SOMEVIN' });

    expect(result).toEqual({ vehicleId: 'vin-match-id', location: undefined });
  });

  it('exports the shared Unknown Location label', () => {
    expect(UNMAPPED_LEAD_LOCATION_LABEL).toBe('Unknown Location');
  });
});
