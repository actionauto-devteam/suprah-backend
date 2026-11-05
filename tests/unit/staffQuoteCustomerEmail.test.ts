/**
 * Shipment emails. A customer who follows the shipment in their portal gets
 * the key steps (driver accepted, picked up, delivered) with a link to My
 * Shipments; a staff quote's customer without a portal account keeps booked,
 * on-its-way and delivered. Every email names the dealership and Suprah AI.
 * Models and the email service are stand-ins; nothing is sent.
 */
const mockQuoteFindOne = jest.fn();
const mockOrgFindById = jest.fn();
const mockSendEmail = jest.fn();
const mockFindQuoteFollower = jest.fn();
jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockQuoteFindOne(filter)) }) }) },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: (id: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockOrgFindById(id)) }) }) },
}));
jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendEmail: (...args: unknown[]) => mockSendEmail(...args) },
}));
jest.mock('../../src/services/shipmentFollower', () => ({
  __esModule: true,
  findQuoteFollower: (quote: unknown) => mockFindQuoteFollower(quote),
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import {
  FOLLOWER_EMAIL_EVENTS,
  STAFF_QUOTE_EMAIL_EVENTS,
  emailStaffQuoteCustomer,
  staffQuoteCustomerEmail,
  type StaffQuoteEmailEvent,
} from '../../src/services/staffQuoteCustomerEmail';

const ORG = '64b0000000000000000000a9';
const QUOTE = '64b0000000000000000000b9';
const ctx = { customerFirstName: 'Maria', vehicleName: '2021 Toyota Camry', dealerName: 'Action Auto Utah', loadNumber: 'LD-7' };
const ALL_EVENTS: StaffQuoteEmailEvent[] = ['booked', 'driver_accepted', 'picked_up', 'on_the_way', 'delivered'];

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindOne.mockReturnValue({ email: ' Maria@Example.com ', firstName: 'Maria', vehicleName: '2021 Toyota Camry' });
  mockOrgFindById.mockReturnValue({ name: 'Action Auto Utah' });
  mockSendEmail.mockResolvedValue(undefined);
  mockFindQuoteFollower.mockResolvedValue(null);
});

describe('staffQuoteCustomerEmail', () => {
  it('words each step plainly, naming the dealership and Suprah AI', () => {
    expect(staffQuoteCustomerEmail('booked', ctx).subject).toBe('Your 2021 Toyota Camry shipment is booked');
    expect(staffQuoteCustomerEmail('booked', ctx).text).toContain(
      "Action Auto Utah booked the shipment for your 2021 Toyota Camry (shipment LD-7). We'll email you when it's on its way.",
    );
    expect(staffQuoteCustomerEmail('on_the_way', ctx).subject).toBe('Your 2021 Toyota Camry is on its way');
    expect(staffQuoteCustomerEmail('on_the_way', ctx).text).toContain('was picked up and is on its way to you (shipment LD-7).');
    expect(staffQuoteCustomerEmail('delivered', ctx).text).toContain('was delivered (shipment LD-7). Thank you for choosing Action Auto Utah.');
    expect(staffQuoteCustomerEmail('delivered', ctx).text).toContain("If something isn't right, contact Action Auto Utah.");
    expect(staffQuoteCustomerEmail('delivered', ctx).text).toContain('Sent by Action Auto Utah through Suprah AI.');
  });

  it("names the driver at the driver steps, and only their name", () => {
    const withDriver = { ...ctx, driverName: 'Mark  Reyes' };
    expect(staffQuoteCustomerEmail('driver_accepted', withDriver).subject).toBe('A driver accepted your 2021 Toyota Camry shipment');
    expect(staffQuoteCustomerEmail('driver_accepted', withDriver).text).toContain(
      'Mark Reyes accepted the shipment for your 2021 Toyota Camry (shipment LD-7). You can see your driver and follow each step in My Shipments.',
    );
    expect(staffQuoteCustomerEmail('picked_up', withDriver).text).toContain('Your 2021 Toyota Camry was picked up by Mark Reyes (shipment LD-7).');
    expect(staffQuoteCustomerEmail('driver_accepted', {}).text).toContain('A driver accepted the shipment for your vehicle.');
  });

  it('adds the My Shipments button only for a real web address', () => {
    const linked = staffQuoteCustomerEmail('picked_up', { ...ctx, shipmentsUrl: 'https://app.suprah.ai/customer/shipments' });
    expect(linked.text).toContain('Open My Shipments: https://app.suprah.ai/customer/shipments');
    expect(linked.html).toContain('href="https://app.suprah.ai/customer/shipments"');
    for (const bad of ['javascript:alert(1)', 'https://x.test/" onclick="y', '']) {
      const email = staffQuoteCustomerEmail('picked_up', { ...ctx, shipmentsUrl: bad });
      expect(email.html).not.toContain('Open My Shipments');
      expect(email.text).not.toContain('Open My Shipments');
    }
  });

  it('reads well with nothing known, and never lets names add markup', () => {
    const plain = staffQuoteCustomerEmail('delivered', {});
    expect(plain.subject).toBe('Your vehicle was delivered');
    expect(plain.text).toContain('Hi there,');
    expect(plain.text).not.toMatch(/undefined|null/);
    for (const event of ALL_EVENTS) {
      const html = staffQuoteCustomerEmail(event, { ...ctx, customerFirstName: '<b>x</b>', driverName: '<img src=x>' }).html;
      expect(html).not.toContain('<b>x</b>');
      expect(html).not.toContain('<img src=x>');
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    }
  });
});

describe('emailStaffQuoteCustomer', () => {
  it("emails a staff-made quote's customer without a portal account at booked, on its way and delivered", async () => {
    expect(await emailStaffQuoteCustomer(ORG, QUOTE, 'booked', { loadNumber: 'LD-7' })).toBe(true);
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG });
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'maria@example.com',
      subject: 'Your 2021 Toyota Camry shipment is booked',
      organizationId: ORG,
    }));
    expect(mockSendEmail.mock.calls[0][0].html).not.toContain('Open My Shipments');

    mockSendEmail.mockClear();
    for (const event of ALL_EVENTS) await emailStaffQuoteCustomer(ORG, QUOTE, event);
    expect(mockSendEmail).toHaveBeenCalledTimes(STAFF_QUOTE_EMAIL_EVENTS.size);
  });

  it('emails a customer who follows it in their portal at the key steps only, with the My Shipments link', async () => {
    mockFindQuoteFollower.mockResolvedValue({ id: 'c1', name: 'Maria  Lopez', email: 'maria.lopez@example.com', kind: 'shared' });
    for (const event of ALL_EVENTS) await emailStaffQuoteCustomer(ORG, QUOTE, event, { driverName: 'Mark Reyes' });
    expect(mockSendEmail).toHaveBeenCalledTimes(FOLLOWER_EMAIL_EVENTS.size);
    const first = mockSendEmail.mock.calls[0][0];
    expect(first.to).toBe('maria.lopez@example.com');
    expect(first.subject).toBe('A driver accepted your 2021 Toyota Camry shipment');
    expect(first.text).toContain('Hi Maria,');
    expect(first.text).toContain('Open My Shipments: http://localhost:3000/customer/shipments');
  });

  it("doesn't email a portal request with no account, quotes without a usable email, or other dealerships' quotes", async () => {
    mockQuoteFindOne.mockReturnValueOnce({ source: 'customer_portal', email: 'maria@example.com' });
    expect(await emailStaffQuoteCustomer(ORG, QUOTE, 'delivered')).toBe(false);
    mockQuoteFindOne.mockReturnValueOnce({ email: 'not-an-email' });
    expect(await emailStaffQuoteCustomer(ORG, QUOTE, 'delivered')).toBe(false);
    mockQuoteFindOne.mockReturnValueOnce(null);
    expect(await emailStaffQuoteCustomer(ORG, QUOTE, 'delivered')).toBe(false);
    expect(await emailStaffQuoteCustomer('not-an-org', QUOTE, 'delivered')).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('never fails the shipment step when sending fails', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('mail down'));
    await expect(emailStaffQuoteCustomer(ORG, QUOTE, 'on_the_way')).resolves.toBe(false);
    mockFindQuoteFollower.mockRejectedValueOnce(new Error('db down'));
    await expect(emailStaffQuoteCustomer(ORG, QUOTE, 'delivered')).resolves.toBe(false);
  });
});
