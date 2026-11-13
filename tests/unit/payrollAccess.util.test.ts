import { hasPayrollAccess, payrollAccessSwitch } from '../../src/utils/payrollAccess.util';

describe('hasPayrollAccess (View Users access)', () => {
  it('follows the switch for admins and managers', () => {
    expect(hasPayrollAccess({ role: 'admin', payrollAccess: true })).toBe(true);
    expect(hasPayrollAccess({ role: 'admin', payrollAccess: false })).toBe(false);
    expect(hasPayrollAccess({ role: 'manager', payrollAccess: true })).toBe(true);
    expect(hasPayrollAccess({ role: 'manager', payrollAccess: false })).toBe(false);
  });

  it('keeps existing admins on and existing managers off when the switch was never set', () => {
    expect(hasPayrollAccess({ role: 'admin' })).toBe(true);
    expect(hasPayrollAccess({ role: 'admin', payrollAccess: null })).toBe(true);
    expect(hasPayrollAccess({ role: 'manager' })).toBe(false);
  });

  it('never gives access to employees, system accounts or missing users', () => {
    expect(hasPayrollAccess({ role: 'employee', payrollAccess: true })).toBe(false);
    expect(hasPayrollAccess({ role: 'admin', isSystem: true })).toBe(false);
    expect(hasPayrollAccess(null)).toBe(false);
    expect(hasPayrollAccess(undefined)).toBe(false);
  });

  it('always gives Web Dev admins and managers access, even with the switch off', () => {
    expect(hasPayrollAccess({ role: 'admin', department: 'WebDevTeam', payrollAccess: false })).toBe(true);
    expect(hasPayrollAccess({ role: 'manager', department: 'WebDevTeam', payrollAccess: false })).toBe(true);
    expect(hasPayrollAccess({ role: 'manager', department: 'WebDevTeam' })).toBe(true);
  });

  it('does not give Web Dev employees access and leaves other departments on the switch', () => {
    expect(hasPayrollAccess({ role: 'employee', department: 'WebDevTeam', payrollAccess: true })).toBe(false);
    expect(hasPayrollAccess({ role: 'manager', department: 'Accounting', payrollAccess: false })).toBe(false);
    expect(hasPayrollAccess({ role: 'admin', department: null, payrollAccess: false })).toBe(false);
  });

  it('keeps the saved switch separate from the Web Dev override', () => {
    expect(payrollAccessSwitch({ role: 'admin', department: 'WebDevTeam', payrollAccess: false })).toBe(false);
    expect(payrollAccessSwitch({ role: 'manager', department: 'WebDevTeam' })).toBe(false);
    expect(payrollAccessSwitch({ role: 'admin', department: 'WebDevTeam' })).toBe(true);
  });
});
