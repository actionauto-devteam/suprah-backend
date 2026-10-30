/**
 * The salesperson on a quote's linked CRM lead hears about a new customer
 * request and about the shipment being delivered or cancelled: only active
 * staff of the same dealership, never the person who took the step, and not
 * twice when the dealership's admins already got the notice. Models are
 * stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockLeadFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockCreateNotification = jest.fn();

const chain = (result: () => unknown) => {
  const self: any = { select: () => self, lean: () => Promise.resolve(result()) };
  return self;
};

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => chain(() => mockQuoteFindOne(filter)) },
}));
jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => chain(() => mockLeadFindOne(filter)) },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => chain(() => mockUserFindOne(filter)) },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));

import { NOTIFICATION_TYPES } from '../../src/constants/notificationTypes';
import {
  findQuoteSalesperson,
  notifyQuoteSalesperson,
  salespersonNotice,
  salespersonNotification,
  type SalespersonEvent,
} from '../../src/services/leadSalesperson.service';

const ORG = '64b0000000000000000000a1';
const QUOTE = '64b0000000000000000000b1';
const LEAD = '64b0000000000000000000c1';
const SALES = '64b0000000000000000000d1';
const LOAD = '64b0000000000000000000e1';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindOne.mockReturnValue({ leadId: LEAD, firstName: 'Maria', lastName: 'Santos', vehicleName: '2021 Toyota Camry' });
  mockLeadFindOne.mockReturnValue({ assignedTo: SALES });
  mockUserFindOne.mockReturnValue({ role: 'employee' });
});

describe('salesperson notices', () => {
  it('use notification types the platform accepts, with plain titles', () => {
    for (const event of ['request', 'delivered', 'cancelled'] as SalespersonEvent[]) {
      const notice = salespersonNotice(event, { customerName: 'Maria Santos', vehicleName: 'Camry', loadNumber: 'LD-7' });
      expect((NOTIFICATION_TYPES as readonly string[]).includes(notice.type)).toBe(true);
      expect(notice.title).toMatch(/^Your Customer/);
      expect(notice.message).not.toMatch(/undefined|null/);
    }
  });

  it('say whose shipment it is and what happened', () => {
    expect(salespersonNotice('request', { customerName: 'Maria Santos', vehicleName: '2021 Toyota Camry' }).message).toBe(
      "Maria Santos asked for a shipping quote for the 2021 Toyota Camry from the customer portal. You'll find it under Quotes in Transportation.",
    );
    expect(salespersonNotice('delivered', { customerName: 'Maria Santos', vehicleName: 'Camry', loadNumber: 'LD-7' }).message).toBe(
      "Maria Santos's shipment for the Camry (load LD-7) was delivered.",
    );
    expect(salespersonNotice('cancelled', { customerName: 'Maria Santos', vehicleName: 'Camry', loadNumber: 'LD-7', reason: 'Other: Buyer backed out.' }).message).toBe(
      "Maria Santos's shipment for the Camry (load LD-7) was cancelled. Reason: Other: Buyer backed out.",
    );
    expect(salespersonNotice('delivered', {}).message).toBe("Your customer's shipment for their vehicle was delivered.");
  });

  it('open the load, or Quotes for a new request', () => {
    const salesperson = { userId: SALES, quoteId: QUOTE, customerName: 'Maria Santos' };
    expect(salespersonNotification(salesperson, ORG, 'delivered', { loadId: LOAD, loadNumber: 'LD-7' }).metadata).toEqual({
      quoteId: QUOTE,
      loadId: LOAD,
      loadNumber: 'LD-7',
      route: `/transportation/load/${LOAD}`,
    });
    expect(salespersonNotification(salesperson, ORG, 'request').metadata).toEqual({
      quoteId: QUOTE,
      route: '/transportation?tab=drafts',
    });
  });
});

describe('who the salesperson is', () => {
  it("is the lead's assigned staff member in the same dealership", async () => {
    expect(await findQuoteSalesperson(ORG, QUOTE)).toEqual({
      userId: SALES,
      quoteId: QUOTE,
      customerName: 'Maria Santos',
      vehicleName: '2021 Toyota Camry',
    });
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG });
    expect(String(mockLeadFindOne.mock.calls[0][0].organizationId)).toBe(ORG);
    expect(mockUserFindOne).toHaveBeenCalledWith({
      _id: SALES,
      organizationId: ORG,
      isActive: true,
      role: { $in: ['employee', 'admin', 'super_admin'] },
    });
  });

  it('is nobody when the quote has no lead, the lead has no one, or that person is not active staff here', async () => {
    mockQuoteFindOne.mockReturnValueOnce({ firstName: 'Maria' });
    expect(await findQuoteSalesperson(ORG, QUOTE)).toBeNull();

    mockLeadFindOne.mockReturnValueOnce({ assignedTo: null });
    expect(await findQuoteSalesperson(ORG, QUOTE)).toBeNull();

    mockLeadFindOne.mockReturnValueOnce(null);
    expect(await findQuoteSalesperson(ORG, QUOTE)).toBeNull();

    mockUserFindOne.mockReturnValueOnce(null);
    expect(await findQuoteSalesperson(ORG, QUOTE)).toBeNull();

    expect(await findQuoteSalesperson(ORG, 'not-an-id')).toBeNull();
    expect(await findQuoteSalesperson('not-an-org', QUOTE)).toBeNull();
  });

  it('leaves out whoever took the step or was already told', async () => {
    expect(await findQuoteSalesperson(ORG, QUOTE, { excludeUserIds: [SALES] })).toBeNull();
    expect(await findQuoteSalesperson(ORG, QUOTE, { excludeUserIds: [undefined, null, 'someone-else'] })).not.toBeNull();
  });

  it('leaves out admins when the admins already got the notice', async () => {
    mockUserFindOne.mockReturnValue({ role: 'admin' });
    expect(await findQuoteSalesperson(ORG, QUOTE, { skipAdmins: true })).toBeNull();
    expect(await findQuoteSalesperson(ORG, QUOTE)).not.toBeNull();

    mockUserFindOne.mockReturnValue({ role: 'employee', organizationRole: 'admin' });
    expect(await findQuoteSalesperson(ORG, QUOTE, { skipAdmins: true })).toBeNull();
  });
});

describe('telling the salesperson about a new request', () => {
  it('sends one notice to the salesperson', async () => {
    expect(await notifyQuoteSalesperson(ORG, QUOTE, { skipAdmins: true })).toBe(true);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SALES, organizationId: ORG, type: 'quote_created', title: 'Your Customer Sent a Shipping Request' }),
    );
  });

  it('never fails the customer request when the notice fails', async () => {
    mockCreateNotification.mockRejectedValueOnce(new Error('down'));
    await expect(notifyQuoteSalesperson(ORG, QUOTE)).resolves.toBe(false);
    mockQuoteFindOne.mockImplementationOnce(() => { throw new Error('down'); });
    await expect(notifyQuoteSalesperson(ORG, QUOTE)).resolves.toBe(false);
  });
});
