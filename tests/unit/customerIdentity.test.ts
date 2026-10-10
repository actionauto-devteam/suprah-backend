import mongoose from 'mongoose';
import Customer from '../../src/models/Customer.model';
import Lead from '../../src/models/lead.model';
import { contactIdentity, normalizeIdentityEmail, normalizeIdentityPhone } from '../../src/utils/contactIdentity';
import { evaluateCustomerIdentity, findIdentityCustomers, findUniqueCustomerByPhone, syncLeadCustomer, syncLeadCustomerSafely } from '../../src/services/customerIdentity.service';

jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/services/customerIdentityLock.service', () => ({ withCustomerIdentityLock: jest.fn(async (_org, operation) => operation(async () => undefined)) }));

const org = new mongoose.Types.ObjectId().toString();
const makeCustomer = (data: any = {}) => ({ _id: new mongoose.Types.ObjectId(), organizationId: org, isActive: true, ...data });

afterEach(() => jest.restoreAllMocks());

describe('Contact identity normalization and resolution', () => {
  test.each(['8015550123', '(801) 555-0123', '1-801-555-0123', '+1 801 555 0123'])('normalizes %s to full E.164', phone => {
    expect(normalizeIdentityPhone(phone)).toBe('+18015550123');
  });
  test('keeps country codes and extensions, rejects short and invalid contacts', () => {
    expect(normalizeIdentityPhone('+49 30 12345678')).toBe('+493012345678');
    expect(normalizeIdentityPhone('3012345678')).toBe('+13012345678');
    expect(normalizeIdentityPhone('8015550123 ext 42')).toBe('+18015550123;ext=42');
    expect(normalizeIdentityPhone('5550123')).toBeNull();
    expect(normalizeIdentityPhone('call 8015550123')).toBeNull();
    expect(normalizeIdentityEmail('  PERSON@Example.COM ')).toBe('person@example.com');
    expect(normalizeIdentityEmail('invalid')).toBeNull();
  });
  test('phone-only and email-only resolve a single Customer', () => {
    const phone = makeCustomer({ phone: '(801) 555-0123' });
    const email = makeCustomer({ email: 'PERSON@example.com' });
    expect(evaluateCustomerIdentity({ phone: '+18015550123' }, [phone]).customerId).toBe(String(phone._id));
    expect(evaluateCustomerIdentity({ email: 'person@example.com' }, [email]).customerId).toBe(String(email._id));
  });
  test('same last ten digits across countries are not identity proof', () => {
    expect(evaluateCustomerIdentity({ phone: '+13012345678' }, [makeCustomer({ phone: '+493012345678' })]).status).toBe('unresolved');
  });
  test('multiple matching customers and disagreeing contacts require review', () => {
    expect(evaluateCustomerIdentity({ phone: '8015550123' }, [makeCustomer({ phone: '8015550123' }), makeCustomer({ phone: '+18015550123' })]).status).toBe('ambiguous');
    expect(evaluateCustomerIdentity({ email: 'a@example.com', phone: '8015550123' }, [makeCustomer({ email: 'b@example.com', phone: '8015550123' })]).status).toBe('conflict');
    expect(evaluateCustomerIdentity({ email: 'a@example.com', phone: '8015550123' }, [makeCustomer({ email: 'a@example.com', phone: '8015550124' })]).status).toBe('conflict');
    expect(evaluateCustomerIdentity({ phone: '8015550123' }, [makeCustomer({ phone: '8015550123', isActive: false })]).status).toBe('conflict');
  });
  test('does not use names to identify people', () => {
    expect(evaluateCustomerIdentity({}, [makeCustomer({ firstName: 'Same', lastName: 'Name' })]).status).toBe('unresolved');
    expect(contactIdentity({ phone: '' }).normalizedPhone).toBeNull();
  });
  test('customer lookup always scopes by organizationId, never an unscoped fallback', async () => {
    const customer = makeCustomer({ phone: '8015550123' });
    const cursor = { async *[Symbol.asyncIterator]() { yield customer; }, close: jest.fn() };
    const query: any = { select: jest.fn().mockReturnThis(), maxTimeMS: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), cursor: () => cursor };
    const find = jest.spyOn(Customer, 'find').mockReturnValue(query);
    expect(await findUniqueCustomerByPhone(org, '8015550123')).toEqual(customer);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toMatchObject({ organizationId: org });
    expect(cursor.close).toHaveBeenCalled();
    await expect(findIdentityCustomers('', { phone: '8015550123' })).rejects.toThrow('Organization');
  });
  test('lookup does not return an ambiguous customer', async () => {
    const cursor = { async *[Symbol.asyncIterator]() { yield makeCustomer({ phone: '8015550123' }); yield makeCustomer({ phone: '8015550123' }); }, close: jest.fn() };
    const query: any = { select: jest.fn().mockReturnThis(), maxTimeMS: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), cursor: () => cursor };
    jest.spyOn(Customer, 'find').mockReturnValue(query);
    expect(await findUniqueCustomerByPhone(org, '8015550123')).toBeNull();
  });
  test('DB failure leaves a retry marker instead of failing intake', async () => {
    jest.spyOn(Lead, 'findOne').mockReturnValue({ maxTimeMS: () => ({ lean: () => Promise.reject(new Error('DB failure')) }) } as any);
    const update = jest.spyOn(Lead, 'updateOne').mockResolvedValue({ matchedCount: 1 } as any);
    const id = String(new mongoose.Types.ObjectId());
    expect((await syncLeadCustomerSafely(org, id)).status).toBe('retry');
    expect(update).toHaveBeenCalledWith({ _id: id, organizationId: org }, expect.objectContaining({ $set: expect.objectContaining({ 'customerLink.status': 'retry' }) }), expect.anything());
    await expect(syncLeadCustomer('', id)).rejects.toThrow();
  });
});
