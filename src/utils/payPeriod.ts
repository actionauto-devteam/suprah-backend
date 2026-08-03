import { COMPANY_TZ_OFFSET_MINUTES, getCompanyDayRange } from './companyTimezone';

/**
 * Fixed bi-monthly pay periods: 1st–15th (paid the 20th of the same month)
 * and 16th–end-of-month (paid the 5th of the following month) — matches the
 * cut-off/payout dates already shown throughout the TimeProof UI
 * (isPayoutUnblurWindow, the Payout Calculator, payslip generation).
 */
export interface PayPeriodBounds {
  periodStart: Date; // company-local midnight starting the period, as a UTC instant
  periodEnd: Date;   // company-local midnight AFTER the period's last day (exclusive), as a UTC instant
  payDayDate: Date;  // company-local midnight of the fixed payday, as a UTC instant
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Returns the pay period (and its fixed payday) that the given date falls into. */
export function getPayPeriodBounds(date: Date): PayPeriodBounds {
  const local = new Date(date.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth(); // 0-indexed
  const day = local.getUTCDate();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  if (day <= 15) {
    return {
      periodStart: getCompanyDayRange(`${year}-${pad2(month + 1)}-01`).start,
      periodEnd: getCompanyDayRange(`${year}-${pad2(month + 1)}-15`).end,
      payDayDate: getCompanyDayRange(`${year}-${pad2(month + 1)}-20`).start,
    };
  }

  const nextMonthIndex = (month + 1) % 12;
  const nextMonthYear = month === 11 ? year + 1 : year;

  return {
    periodStart: getCompanyDayRange(`${year}-${pad2(month + 1)}-16`).start,
    periodEnd: getCompanyDayRange(`${year}-${pad2(month + 1)}-${lastDayOfMonth}`).end,
    payDayDate: getCompanyDayRange(`${nextMonthYear}-${pad2(nextMonthIndex + 1)}-05`).start,
  };
}

/** Same bounds, addressed by an explicit YYYY-MM-DD and period number (1 = 1st–15th, 2 = 16th–EOM) — used when an admin picks a period on the Payroll Status page rather than "whatever period today falls in". */
export function getPayPeriodBoundsFor(year: number, month0: number, periodNumber: 1 | 2): PayPeriodBounds {
  const anchorDay = periodNumber === 1 ? 10 : 20;
  return getPayPeriodBounds(getCompanyDayRange(`${year}-${pad2(month0 + 1)}-${pad2(anchorDay)}`).start);
}
