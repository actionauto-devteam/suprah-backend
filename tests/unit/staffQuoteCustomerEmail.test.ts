/**
 * Customers of staff-made quotes get booked, on-its-way and delivered updates
 * by email, naming the dealership and sent through Suprah AI. Portal customers
 * already get these in the app, so they aren't emailed. Models and the email
 * service are stand-ins; nothing is sent.
 */
const mockQuoteFindOne = jest.fn();
const mockOrgFindById = jest.fn();
const mockSendEmail = jest.fn();
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
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { emailStaffQuoteCustomer, staffQuoteCustomerEmail } from '../../src/services/staffQuoteCustomerEmail';

const ORG = '64b0000000000000000000a9';
const QUOTE = '64b0000000000000000000b9';
const ctx = { customerFirstName: 'Maria', vehicleName: '2021 Toyota Camry', dealerName: 'Action Auto Utah', loadNumber: 'LD-7' };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindOne.mockReturnValue({ email: ' Maria@Example.com ', firstName: 'Maria', vehicleName: '2021 Toyota Camry' });
  mockOrgFindById.mockReturnValue({ name: 'Action Auto Utah' });
  mockSendEmail.mockResolvedValue(undefined);
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
    expect(staffQuoteCustomerEmail('delivered', ctx).text).toContain('Sent by Action Auto Utah through Suprah AI.');
  });

  it('reads well with nothing known, and never lets names add markup', () => {
    const plain = staffQuoteCustomerEmail('delivered', {});
    expect(plain.subject).toBe('Your vehicle was delivered');
    expect(plain.text).toContain('Hi there,');
    expect(plain.text).not.toMatch(/undefined|null/);
    const html = staffQuoteCustomerEmail('booked', { ...ctx, customerFirstName: '<b>x</b>' }).html;
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('emailStaffQuoteCustomer', () => {
  it("emails a staff-made quote's customer, from the dealership when it has a connected mailbox", async () => {
    expect(await emailStaffQuoteCustomer(ORG, QUOTE, 'booked', { loadNumber: 'LD-7' })).toBe(true);
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG });
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'maria@example.com',
      subject: 'Your 2021 Toyota Camry shipment is booked',
      organizationId: ORG,
    }));
  });

  it("doesn't email portal customers, quotes without a usable email, or other dealerships' quotes", async () => {
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
  });
});
