import { financeApplicationExtras, financeApplicationOwner } from '../../src/utils/financeApplicationDetails';

// A made-up applicant (test data only).
const body = {
  personalInfo: { firstName: 'Ana', applicationType: 'joint', maritalStatus: 'married', driversLicenseNumber: '  D1234567 ' },
  employmentInfo: { employer: 'Acme', workPhone: '(801) 555-0102', payFrequency: 'bi-weekly' },
  residence: { housingStatus: 'rent', monthlyPayment: 1200, yearsAtAddress: '2', monthsAtAddress: 3 },
  reference: { name: ' Sam Lee ', relationship: 'Friend', phone: '8015550101' },
  tradeIn: { hasTradeIn: true, year: '2015', make: 'Honda', model: 'Civic', mileage: '98000' },
};

describe('financeApplicationExtras', () => {
  it("keeps the form's other answers, cleaned", () => {
    expect(financeApplicationExtras(body)).toEqual({
      applicationType: 'joint',
      maritalStatus: 'married',
      driversLicenseNumber: 'D1234567',
      workPhone: '(801) 555-0102',
      payFrequency: 'bi-weekly',
      residence: { housingStatus: 'rent', monthlyPayment: 1200, yearsAtAddress: 2, monthsAtAddress: 3 },
      reference: { name: 'Sam Lee', relationship: 'Friend', phone: '8015550101' },
      tradeIn: { hasTradeIn: true, year: '2015', make: 'Honda', model: 'Civic', mileage: '98000' },
    });
  });

  it('leaves out answers that are not one of the choices or not a sensible number', () => {
    const extras = financeApplicationExtras({
      personalInfo: { applicationType: 'business', maritalStatus: { $ne: 1 } },
      employmentInfo: { payFrequency: 'daily' },
      residence: { housingStatus: 'castle', monthlyPayment: -5, yearsAtAddress: 'abc', monthsAtAddress: 14 },
    });
    expect(extras.applicationType).toBeUndefined();
    expect(extras.maritalStatus).toBeUndefined();
    expect(extras.payFrequency).toBeUndefined();
    expect(extras.residence).toBeUndefined();
  });

  it('a trade-in that was declined keeps only the answer', () => {
    expect(financeApplicationExtras({ tradeIn: { hasTradeIn: false, make: 'Honda' } }).tradeIn).toEqual({ hasTradeIn: false });
    expect(financeApplicationExtras({}).tradeIn).toBeUndefined();
  });

  it('keeps text short and ignores a missing body', () => {
    const long = 'x'.repeat(500);
    expect(financeApplicationExtras({ reference: { name: long } }).reference?.name).toHaveLength(100);
    expect(financeApplicationExtras(undefined)).toEqual({
      applicationType: undefined,
      maritalStatus: undefined,
      driversLicenseNumber: undefined,
      workPhone: undefined,
      payFrequency: undefined,
      residence: undefined,
      reference: undefined,
      tradeIn: undefined,
    });
  });
});

describe('financeApplicationOwner', () => {
  const findCustomer = jest.fn(async (email: string) => (email === 'ana@example.com' ? 'customer-1' : null));
  beforeEach(() => findCustomer.mockClear());

  it("a customer's own application is theirs", async () => {
    expect(await financeApplicationOwner({ _id: 'customer-9', role: 'customer' }, 'other@example.com', findCustomer)).toEqual({
      customerId: 'customer-9',
    });
    expect(findCustomer).not.toHaveBeenCalled();
  });

  it("staff filling it in record it under that customer's account", async () => {
    expect(await financeApplicationOwner({ _id: 'staff-1', role: 'employee' }, '  Ana@Example.com ', findCustomer)).toEqual({
      customerId: 'customer-1',
      submittedBy: 'staff-1',
    });
  });

  it("with no customer account for that email, it's kept without one and notes who filled it in", async () => {
    expect(await financeApplicationOwner({ _id: 'staff-1', role: 'admin' }, 'new@example.com', findCustomer)).toEqual({
      customerId: undefined,
      submittedBy: 'staff-1',
    });
    expect(await financeApplicationOwner({ _id: 'staff-1', role: 'dealer' }, '', findCustomer)).toEqual({
      customerId: undefined,
      submittedBy: 'staff-1',
    });
  });
});
