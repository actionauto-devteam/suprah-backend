const mockOrgLeadConfigFindOne = jest.fn();
const mockVehicleFindById = jest.fn();
const mockOrganizationFindById = jest.fn();
const mockLeadCreate = jest.fn();
const mockIntakeClaimFindOneAndUpdate = jest.fn();
const mockIntakeClaimUpdateOne = jest.fn();
const mockIntakeClaimDeleteOne = jest.fn();
const mockResolveOrgSystemUserId = jest.fn();
const mockEmitToOrg = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('../../src/models/OrgLeadConfig.model', () => ({
  __esModule: true,
  default: { findOne: mockOrgLeadConfigFindOne },
}));
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findById: mockVehicleFindById },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrganizationFindById },
}));
jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { create: mockLeadCreate },
}));
jest.mock('../../src/models/IntakeClaim.model', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: mockIntakeClaimFindOneAndUpdate,
    updateOne: mockIntakeClaimUpdateOne,
    deleteOne: mockIntakeClaimDeleteOne,
  },
}));
jest.mock('../../src/services/orgGmail.service', () => ({
  __esModule: true,
  default: { sendEmail: mockSendEmail },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { broadcastNotification: jest.fn() },
}));
jest.mock('../../src/utils/orgSystemUser', () => ({
  __esModule: true,
  resolveOrgSystemUserId: mockResolveOrgSystemUserId,
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  __esModule: true,
  emitToOrg: mockEmitToOrg,
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import leadService from '../../src/services/lead.service';

const baseDto = {
  organizationId: 'org-1',
  customerId: 'customer-1',
  vehicleId: 'vehicle-1',
  comments: 'Interested in this car',
  customerName: { first: 'Jordan', last: 'Lee' },
  customerEmail: 'jordan@example.com',
  customerPhone: '8015550100',
};

describe('LeadService.processInquiry (Bounce Flow direct-write)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgLeadConfigFindOne.mockResolvedValue({ gmailConnected: true, leadSourceEmail: 'leads@dealer.com', gmailAddress: 'dealer@gmail.com' });
    mockVehicleFindById.mockResolvedValue({
      _id: 'vehicle-1',
      isNewVehicle: false,
      year: 2024,
      make: 'Toyota',
      modelName: 'Camry',
      vin: '1FAKEVIN',
      stockNumber: 'STK1',
      trim: 'LE',
      price: 25000,
      dealerCity: 'Lehi',
    });
    mockOrganizationFindById.mockResolvedValue({ _id: 'org-1', name: 'Test Dealership' });
    mockResolveOrgSystemUserId.mockResolvedValue('staff-1');
    mockLeadCreate.mockResolvedValue({ _id: 'lead-1', toObject: () => ({ _id: 'lead-1' }) });
    mockIntakeClaimUpdateOne.mockResolvedValue({});
    mockIntakeClaimDeleteOne.mockResolvedValue({});
  });

  it('creates a Lead directly and never sends a bounce email on a first submission', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: {} });

    await leadService.processInquiry(baseDto);

    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
    const [createArgs] = mockLeadCreate.mock.calls[0];
    expect(createArgs.channel).toBe('web');
    expect(createArgs.source).toBe('Website Inquiry');
    expect(createArgs.parsedContent).toEqual(expect.any(String));
    expect(createArgs.vehicleId).toBe('vehicle-1');
    expect(createArgs.location).toBe('Lehi');
    expect(mockIntakeClaimUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ claimKey: 'customer-1:vehicle-1' }),
      expect.objectContaining({ $set: { leadId: 'lead-1' } }),
    );
  });

  it('is a no-op on a second call for the same customer+vehicle inside the dedup window', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: true }, value: { leadId: 'lead-1' } });

    await leadService.processInquiry(baseDto);

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('deletes the claim (does not leave it dangling) if Lead.create rejects', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: {} });
    mockLeadCreate.mockRejectedValue(new Error('db write failed'));

    await expect(leadService.processInquiry(baseDto)).rejects.toThrow('db write failed');

    expect(mockIntakeClaimDeleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ claimKey: 'customer-1:vehicle-1' }),
    );
  });

  it('deletes the claim if no org system user is available', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: {} });
    mockResolveOrgSystemUserId.mockResolvedValue(null);

    await expect(leadService.processInquiry(baseDto)).rejects.toThrow();

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(mockIntakeClaimDeleteOne).toHaveBeenCalledTimes(1);
  });
});
