/**
 * A load's shipping bill (SuprahPay, decisions of 2026-11-25): the automatic
 * SuprahPay invoice to the load's customer or to the dealership, kept in step
 * with the load (made, priced, switched to cash on delivery, cancelled). A
 * car sold to the person receiving it (2026-11-26) also gets the dealership's
 * automatic invoice for the car. The rules themselves are in utils/loadBilling.
 */
import mongoose from 'mongoose';
import Load from '../models/Load.model';
import Payment from '../models/Payment.model';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { notifyOrgAdmins, safeCreateNotification } from '../utils/safeNotification';
import { AWAITING_PAYMENT_STATUSES } from '../utils/customerPayments';
import {
  LoadBillingRecord,
  SUPRAH_BILLING_ORG,
  SUPRAH_ISSUER_NAME,
  billingFromInput,
  carrierPayCapProblem,
  carrierPayOf,
  driverPayGate,
  invoiceTermsFor,
  vehicleInvoiceTerms,
} from '../utils/loadBilling';
import { dealershipForPayments, getPlatformSettings, paymentLimitProblem, suprahPayOn } from './suprahPaySettings.service';
import { notifySuperAdmins } from './dealershipPayouts.service';
import { closeOpenPaymentPages } from '../controllers/payment.controller';

/** The billing fields that are left out of load reads unless named. */
export const BILLING_PRIVATE_FIELDS = '+billing.customerName +billing.customerEmail +billing.shippingPrice +billing.vehiclePrice +billing.vehicleTaxRate';
/**
 * Every billing field, hidden ones included, named one by one. Never
 * "billing" together with its hidden fields: the database refuses a read that
 * asks for a section and a field inside it ("path collision").
 */
export const BILLING_ALL_FIELDS = `billing.billTo billing.method billing.outside billing.invoiceId billing.vehicleInvoiceId billing.cashConfirmedAt billing.cashNotReceivedAt billing.cashCustomerConfirmedAt billing.decidedAt billing.decidedBy ${BILLING_PRIVATE_FIELDS}`;

const money = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** Whether SuprahPay bills this dealership's loads (it's switched on per dealership). */
export async function loadBillingOn(orgId: string): Promise<boolean> {
  if (!mongoose.isValidObjectId(orgId)) return false;
  const org = await Organization.findById(orgId).select('subscription.tier suprahPay.enabled').lean();
  return suprahPayOn(org as any);
}

async function loadWithBilling(loadId: unknown) {
  return Load.findById(loadId).select(`organizationId loadNumber status quoteId createdBy pricing ${BILLING_ALL_FIELDS}`);
}

/** The load's automatic invoice, if it has one. */
async function currentInvoice(load: { billing?: { invoiceId?: unknown } | null }) {
  const id = load.billing?.invoiceId;
  return id ? Payment.findById(id) : null;
}

/** Tells whoever pays that Suprah billed them for the load's shipping. */
async function announceInvoice(
  invoice: { _id: unknown; amount: number; billedTo?: string; customerEmail?: string },
  load: { organizationId: string; loadNumber: string },
  dealershipName: string,
) {
  if (invoice.billedTo === 'dealership') {
    await notifyOrgAdmins(
      load.organizationId,
      'payment_pending',
      'Shipping bill from Suprah',
      `Suprah AI billed your dealership ${money(invoice.amount)} for the driver's pay on load ${load.loadNumber}. Pay it in SuprahPay under Bills from Suprah; the driver is paid once it's paid and the load is delivered.`,
      { paymentId: String(invoice._id), route: '/billing' },
    );
    return;
  }
  const customer = await User.findOne({ email: String(invoice.customerEmail ?? '').toLowerCase(), emailVerified: true }).select('_id').lean();
  if (!customer) return; // they see it once they sign up with this email
  await safeCreateNotification({
    userId: customer._id as any,
    organizationId: load.organizationId,
    type: 'payment_request',
    title: dealershipName ? `SuprahPay invoice from ${dealershipName}` : 'SuprahPay invoice for your shipment',
    message: `${dealershipName || 'Your dealership'} sent you an invoice of ${money(invoice.amount)} for shipping your vehicle (load ${load.loadNumber}). Open SuprahPay to pay it.`,
    metadata: { paymentId: String(invoice._id), amount: invoice.amount, route: '/customer/payments' },
  });
}

/**
 * Sends the load's automatic SuprahPay invoice when its billing calls for one
 * and it doesn't have a matching one yet. Refused (nothing sent) when the
 * amount is over SuprahPay's limit for one payment. Returns the invoice.
 */
export async function issueLoadInvoice(loadId: unknown, actorId?: string) {
  const load = await loadWithBilling(loadId);
  if (!load || load.status === 'Cancelled') return null;
  const terms = invoiceTermsFor(load.billing as LoadBillingRecord, load.pricing as any);
  if (!terms) return null;

  const existing = await currentInvoice(load);
  // A paid shipping invoice is never billed again.
  if (existing?.status === 'succeeded') return existing;
  const existingOpen = existing && (AWAITING_PAYMENT_STATUSES as readonly string[]).includes(existing.status);
  if (existingOpen && existing.billedTo === terms.billedTo && existing.amount === terms.amount) return existing;

  const { maxPaymentAmount } = await getPlatformSettings();
  const limit = paymentLimitProblem(terms.amount, maxPaymentAmount);
  if (limit) throw new ApiError(400, `The shipping invoice can't be sent: ${limit.charAt(0).toLowerCase()}${limit.slice(1)}`);

  const dealership = await Organization.findById(load.organizationId).select('name').lean();
  const dealershipName = String(dealership?.name ?? '').trim();
  // Recorded as made by whoever made the load, or else whoever chose who pays.
  const madeBy = load.createdBy ?? load.billing?.decidedBy ?? actorId;
  const creator = madeBy ? await User.findById(madeBy).select('email').lean() : null;
  const billing = load.billing!;
  const payer = terms.billedTo === 'customer'
    ? { name: String(billing.customerName ?? ''), email: String(billing.customerEmail ?? '') }
    : { name: dealershipName || 'Your dealership', email: String((creator as any)?.email ?? '') };
  if (!madeBy || !payer.name || !payer.email) {
    throw new ApiError(
      400,
      terms.billedTo === 'customer'
        ? "The shipping invoice can't be sent: the customer's name and email are missing on this load."
        : "The dealership's bill can't be sent: the staff member who made this load no longer has an account. Choose who pays again from the load's Billing card.",
    );
  }
  // The earlier invoice (a different amount or payer) is closed first; one
  // paid a moment ago stays, and nothing new is sent.
  if (existingOpen && (await cancelInvoice(existing)) === 'paid') return Payment.findById(existing!._id);

  const invoice = await Payment.create({
    organizationId: SUPRAH_BILLING_ORG,
    forOrganizationId: String(load.organizationId),
    billedTo: terms.billedTo,
    loadId: load._id,
    ...(load.quoteId ? { quoteId: load.quoteId } : {}),
    customerId: payer.email,
    customerName: payer.name,
    customerEmail: payer.email,
    amount: terms.amount,
    currency: 'usd',
    taxRate: 0,
    suprahFeePercent: 0,
    purpose: 'shipping',
    description: `Shipping for load ${load.loadNumber}${dealershipName ? ` (${dealershipName})` : ''}`,
    status: 'pending',
    createdBy: madeBy,
  });

  // One automatic invoice per load: if another request sent one a moment ago, this one is dropped.
  const linked = await Load.findOneAndUpdate(
    { _id: load._id, 'billing.invoiceId': existing ? existing._id : null },
    { $set: { 'billing.invoiceId': invoice._id } },
    { new: true, timestamps: false },
  );
  if (!linked) {
    await Payment.updateOne({ _id: invoice._id }, { $set: { status: 'cancelled' } });
    return currentInvoice((await Load.findById(load._id).select('billing.invoiceId').lean()) as any);
  }
  await announceInvoice(invoice, { organizationId: String(load.organizationId), loadNumber: load.loadNumber }, dealershipName).catch(() => undefined);
  logger.info({ loadId: String(load._id), paymentId: String(invoice._id), billedTo: terms.billedTo }, 'Load shipping invoice sent');
  return invoice;
}

/** The car(s) on the load, as the customer's invoice names them: "2021 Toyota Camry". */
function carsOnLoad(vehicles: unknown): string {
  const list = Array.isArray(vehicles) ? vehicles : [];
  const names = list
    .map((car: any) => [car?.year, car?.make, car?.model].filter((part) => part !== undefined && part !== null && String(part).trim()).join(' ').trim())
    .filter(Boolean);
  const label = names.length ? names.join(', ') : list.length > 1 ? `${list.length} vehicles` : 'Vehicle';
  return label.length > 180 ? `${list.length} vehicles` : label;
}

/**
 * The dealership's automatic SuprahPay invoice to the person receiving a car
 * they bought (2026-11-26): the car's price plus sales tax. It's the
 * dealership's own money (its invoice, its payout, Suprah's usual fee), sent
 * once per load; one staff cancelled can be sent again. Refused (nothing
 * sent) over SuprahPay's limit for one payment. Returns the invoice.
 */
export async function issueVehicleInvoice(loadId: unknown, actorId?: string) {
  const load = await Load.findById(loadId).select(`organizationId loadNumber status createdBy vehicles.year vehicles.make vehicles.model ${BILLING_ALL_FIELDS}`);
  if (!load || load.status === 'Cancelled' || load.billing?.outside) return null;
  const billing = load.billing as LoadBillingRecord;
  const terms = vehicleInvoiceTerms(billing);
  if (!terms) return null;

  const previousId = load.billing?.vehicleInvoiceId ?? null;
  const previous = previousId ? await Payment.findById(previousId) : null;
  // Already sent (and not cancelled): never sent twice.
  if (previous && previous.status !== 'cancelled') return previous;

  const dealership = await dealershipForPayments(String(load.organizationId));
  const limit = paymentLimitProblem(terms.amount, dealership.maxPaymentAmount);
  if (limit) throw new ApiError(400, `The car's invoice can't be sent: ${lowerFirst(limit)}`);
  const customerName = String(billing.customerName ?? '').trim();
  const customerEmail = String(billing.customerEmail ?? '').trim().toLowerCase();
  const madeBy = load.createdBy ?? load.billing?.decidedBy ?? actorId;
  if (!customerName || !customerEmail || !madeBy) {
    throw new ApiError(400, "The car's invoice can't be sent: the customer's name and email are missing on this load.");
  }

  const cars = carsOnLoad((load as any).vehicles);
  const invoice = await Payment.create({
    organizationId: String(load.organizationId),
    loadId: load._id,
    customerId: customerEmail,
    customerName,
    customerEmail,
    currency: 'usd',
    description: `${cars} (load ${load.loadNumber})`,
    purpose: 'vehicle',
    suprahFeePercent: dealership.feePercent,
    lineItems: [{ label: cars, kind: 'product', quantity: 1, unitPrice: terms.subtotal, lineTotal: terms.subtotal }],
    subtotal: terms.subtotal,
    taxRate: terms.taxRate,
    taxAmount: terms.taxAmount,
    amount: terms.amount,
    status: 'pending',
    createdBy: madeBy,
  });

  // One car invoice per load: if another request sent one a moment ago, this one is dropped.
  const linked = await Load.findOneAndUpdate(
    { _id: load._id, 'billing.vehicleInvoiceId': previousId },
    { $set: { 'billing.vehicleInvoiceId': invoice._id } },
    { new: true, timestamps: false },
  );
  if (!linked) {
    await Payment.updateOne({ _id: invoice._id }, { $set: { status: 'cancelled' } });
    const now = await Load.findById(load._id).select('billing.vehicleInvoiceId').lean();
    return now?.billing?.vehicleInvoiceId ? Payment.findById(now.billing.vehicleInvoiceId) : null;
  }

  const customer = await User.findOne({ email: customerEmail, emailVerified: true }).select('_id').lean();
  // Otherwise they see it once they sign up with this email.
  if (customer) {
    await safeCreateNotification({
      userId: customer._id as any,
      organizationId: String(load.organizationId),
      type: 'payment_request',
      title: dealership.name ? `SuprahPay invoice from ${dealership.name}` : 'SuprahPay invoice for your vehicle',
      message: `${dealership.name || 'Your dealership'} sent you an invoice of ${money(terms.amount)} for your vehicle (${cars}). Open SuprahPay to pay it.`,
      metadata: { paymentId: String(invoice._id), amount: terms.amount, route: '/customer/payments' },
    });
  }
  logger.info({ loadId: String(load._id), paymentId: String(invoice._id) }, 'Load car invoice sent');
  return invoice;
}

/** Staff send a load's car invoice again (it wasn't sent, or staff cancelled it). */
export async function sendVehicleInvoice(loadId: unknown, organizationId: string, userId: string) {
  const load = await Load.findById(loadId).select(`organizationId status ${BILLING_ALL_FIELDS}`).lean();
  if (!load || String(load.organizationId) !== String(organizationId)) throw new ApiError(404, 'That load could not be found.');
  if (load.status === 'Cancelled') throw new ApiError(400, "This load was cancelled, so its car's invoice can't be sent.");
  if (!(await loadBillingOn(organizationId))) throw new ApiError(403, "SuprahPay isn't turned on for your dealership.");
  if (!vehicleInvoiceTerms(load.billing as LoadBillingRecord)) {
    throw new ApiError(400, "This load's car isn't sold to the person receiving it, so there's no car invoice to send.");
  }
  await issueVehicleInvoice(load._id, userId);
  return Load.findById(load._id).select(BILLING_ALL_FIELDS).lean();
}

/** Cancels an unpaid invoice (closing its open payment page first). 'paid' when it was paid a moment ago. */
async function cancelInvoice(invoice: any): Promise<'cancelled' | 'paid' | 'none'> {
  if (!invoice || !(AWAITING_PAYMENT_STATUSES as readonly string[]).includes(invoice.status)) {
    return invoice?.status === 'succeeded' ? 'paid' : 'none';
  }
  if ((await closeOpenPaymentPages(invoice)) === 'paid') return 'paid';
  const cancelled = await Payment.findOneAndUpdate(
    { _id: invoice._id, status: { $in: [...AWAITING_PAYMENT_STATUSES] } },
    { $set: { status: 'cancelled' } },
    { new: true },
  );
  return cancelled ? 'cancelled' : 'paid';
}

/** Cancels the load's unpaid automatic invoice. 'paid' when it's already paid. */
export async function cancelLoadInvoice(loadId: unknown): Promise<'cancelled' | 'paid' | 'none'> {
  const load = await Load.findById(loadId).select('billing.invoiceId').lean();
  const invoice = load ? await currentInvoice(load as any) : null;
  return cancelInvoice(invoice);
}

/**
 * Saves who pays for the load and how, then sends, replaces or cancels its
 * automatic invoice to match. Used by Create Load, by staff choosing for an
 * older load the first time its driver is paid, and by Edit Load switching a
 * customer load between SuprahPay and cash on delivery. Nothing changes once
 * the shipping is paid or the driver confirmed the cash. A car sold to the
 * receiver stays sold at its price, to the same customer unless staff enter
 * another; its invoice is sent if it wasn't.
 */
export async function setLoadBilling(loadId: unknown, organizationId: string, input: unknown, userId: string) {
  const load = await loadWithBilling(loadId);
  if (!load || String(load.organizationId) !== String(organizationId)) throw new ApiError(404, 'That load could not be found.');
  if (load.status === 'Cancelled') throw new ApiError(400, "This load was cancelled, so its billing can't change.");
  if (!(await loadBillingOn(organizationId))) throw new ApiError(403, "SuprahPay isn't turned on for your dealership.");
  if (load.pricing?.isPricingEnabled === false || load.billing?.outside) {
    throw new ApiError(400, "Pricing was skipped on this load, so it's settled outside Suprah: your staff pay the driver directly.");
  }
  const invoice = await currentInvoice(load);
  if (invoice?.status === 'succeeded') throw new ApiError(409, "This load's shipping is already paid, so who pays and how can't change.");
  if (load.billing?.cashConfirmedAt) throw new ApiError(409, 'The driver already confirmed the cash for this load, so its billing is settled.');

  const current = (load.billing ?? {}) as LoadBillingRecord;
  // A quote load keeps its customer and the quote price; only the way they pay can change.
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const chosen: Record<string, unknown> = load.quoteId && current.billTo === 'customer'
    ? { billTo: 'customer', method: raw.method, customerName: current.customerName, customerEmail: current.customerEmail, shippingPrice: current.shippingPrice }
    : raw;
  const sold = vehicleInvoiceTerms(current) !== null;
  const merged = sold
    ? {
        ...chosen,
        customerName: chosen.customerName || current.customerName,
        customerEmail: chosen.customerEmail || current.customerEmail,
        vehicle: { price: current.vehiclePrice, taxRate: current.vehicleTaxRate ?? 0 },
      }
    : chosen;
  const result = billingFromInput(merged, load.pricing as any, { soldToReceiver: sold });
  if (!result.ok) throw new ApiError(400, result.message);

  const next = result.billing;
  const set: Record<string, unknown> = {
    'billing.billTo': next.billTo,
    'billing.method': next.method,
    'billing.decidedAt': new Date(),
    'billing.decidedBy': userId,
  };
  const unset: Record<string, ''> = {};
  // A customer's details and price are kept when they switch to cash and back;
  // a dealership load has none (only the buyer's name and email when it sells them the car).
  for (const field of ['customerName', 'customerEmail', 'shippingPrice'] as const) {
    if (next[field] !== undefined) set[`billing.${field}`] = next[field];
    else if (next.billTo === 'dealership') unset[`billing.${field}`] = '';
  }
  // Cash on delivery: the driver collects their whole pay in cash (balance $0). SuprahPay: nothing in cash.
  const pay = carrierPayOf(load.pricing as any);
  if (pay !== null && load.pricing?.isPricingEnabled !== false) {
    const cash = next.method === 'suprahpay' ? 0 : pay;
    set['pricing.copCodAmount'] = cash;
    set['pricing.balanceAmount'] = pay - cash;
  }
  await Load.updateOne({ _id: load._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });

  if (next.method !== 'suprahpay') {
    if ((await cancelLoadInvoice(load._id)) === 'paid') {
      throw new ApiError(409, "This load's shipping was paid a moment ago, so it stays paid through SuprahPay. Refresh the load.");
    }
  } else {
    await issueLoadInvoice(load._id, userId);
  }
  if (sold) await issueVehicleInvoice(load._id, userId);
  return Load.findById(load._id).select(BILLING_ALL_FIELDS).lean();
}

/**
 * A quote converted into a load (customer load at the quote price). If staff
 * already sent the customer a Shipping invoice for this quote by hand: an
 * unpaid one is cancelled and replaced; a paid one went to the dealership, so
 * the load is billed to the dealership instead. Never throws: the load exists
 * either way, and staff can send the invoice from the load.
 */
export async function billConvertedQuoteLoad(
  loadId: unknown,
  quote: { _id: unknown; firstName?: string; lastName?: string; email?: string; rate?: number },
  organizationId: string,
  userId: string,
) {
  try {
    if (!(await loadBillingOn(organizationId))) return;
    const manual = await Payment.find({
      organizationId,
      quoteId: quote._id,
      purpose: 'shipping',
      status: { $in: [...AWAITING_PAYMENT_STATUSES, 'succeeded'] },
    }).select('_id status organizationId stripeCheckoutSessionId stripePaymentIntentId amount customerName');

    let paidByHand = manual.some((p) => p.status === 'succeeded');
    for (const invoice of manual.filter((p) => p.status !== 'succeeded')) {
      if ((await cancelInvoice(invoice)) === 'paid') paidByHand = true;
    }
    const billing = paidByHand
      ? { billTo: 'dealership', method: 'suprahpay' }
      : {
          billTo: 'customer',
          method: 'suprahpay',
          customerName: `${quote.firstName ?? ''} ${quote.lastName ?? ''}`.trim(),
          customerEmail: quote.email,
          // The quote price in dollars and cents.
          shippingPrice: typeof quote.rate === 'number' ? Math.round(quote.rate * 100) / 100 : quote.rate,
        };
    await setLoadBilling(loadId, organizationId, billing, userId);
    await warnAboutUnlinkedShippingInvoices(loadId, quote, organizationId);
    if (manual.length) {
      await notifyOrgAdmins(
        organizationId,
        'general',
        paidByHand ? 'Quote shipping already paid to your dealership' : 'Shipping invoice replaced',
        paidByHand
          ? `The customer already paid your dealership's Shipping invoice for this quote, so Suprah billed your dealership for the driver's pay on the new load instead.`
          : `The Shipping invoice your staff sent for this quote was cancelled: the customer now gets Suprah's shipping invoice for the load instead, so they're billed once.`,
        { loadId: String(loadId), route: '/billing' },
      );
    }
  } catch (error) {
    logger.warn({ loadId: String(loadId), err: (error as Error)?.message }, 'The converted quote load was not billed');
  }
}

/**
 * Shipping invoices staff sent by hand from Leads aren't linked to a quote,
 * so they can't be matched to this shipment for sure. The dealership's admins
 * are told about the customer's unlinked ones instead, so the customer is
 * never billed twice and nothing is cancelled by guesswork.
 */
async function warnAboutUnlinkedShippingInvoices(
  loadId: unknown,
  quote: { email?: string; firstName?: string; lastName?: string },
  organizationId: string,
) {
  const email = String(quote.email ?? '').trim().toLowerCase();
  if (!email) return;
  const lookalikes = await Payment.find({
    organizationId,
    purpose: 'shipping',
    customerEmail: email,
    quoteId: { $exists: false },
    loadId: { $exists: false },
    status: { $in: [...AWAITING_PAYMENT_STATUSES, 'succeeded'] },
  }).select('invoiceNumber amount status').limit(5).lean();
  if (!lookalikes.length) return;
  const load = await Load.findById(loadId).select('loadNumber').lean();
  const name = `${quote.firstName ?? ''} ${quote.lastName ?? ''}`.trim() || 'This customer';
  const list = lookalikes
    .map((p: any) => `${p.invoiceNumber ?? 'an invoice'} for ${money(Number(p.amount) || 0)}${p.status === 'succeeded' ? ', paid' : ''}`)
    .join('; ');
  const anyPaid = lookalikes.some((p: any) => p.status === 'succeeded');
  await notifyOrgAdmins(
    organizationId,
    'general',
    'Check for a second shipping invoice',
    `${name} now has Suprah's shipping invoice for load ${load?.loadNumber ?? ''}. They also have a Shipping invoice your staff sent by hand (${list}). If it was for this same shipment, cancel the unpaid one in SuprahPay so they're billed once${anyPaid ? `; if they already paid it for this shipment, contact Suprah AI support so Suprah's invoice can be cancelled` : ''}.`,
    { loadId: String(loadId), route: '/billing/payments' },
  );
}

/** Whether Edit Load's new pricing breaks the load's billing; the reason when it does. */
export async function pricingEditProblem(loadId: unknown, nextPricing: { isPricingEnabled?: boolean; carrierPayAmount?: number }) {
  const load = await loadWithBilling(loadId);
  if (!load?.billing?.billTo || load.billing.outside) return null;
  if (nextPricing.isPricingEnabled === false) {
    const invoice = await currentInvoice(load);
    if (invoice?.status === 'succeeded') {
      return "This load's shipping was already paid through SuprahPay, so pricing can't be skipped now.";
    }
    return null;
  }
  if (load.billing.billTo === 'customer' && load.billing.method === 'suprahpay') {
    return carrierPayCapProblem(carrierPayOf(nextPricing), load.billing.shippingPrice);
  }
  if (load.billing.billTo === 'dealership') {
    // The dealership was billed the driver's pay: once that bill is paid, the pay can't change.
    const invoice = await currentInvoice(load);
    const next = carrierPayOf(nextPricing);
    if (invoice?.status === 'succeeded' && next !== null && next !== invoice.amount) {
      return `Your dealership already paid this load's bill of ${money(invoice.amount)}, so the driver's pay can't change now.`;
    }
  }
  return null;
}

/** After Edit Load saved new pricing: keep the billing and its invoice in step. */
export async function afterPricingSaved(loadId: unknown) {
  const load = await loadWithBilling(loadId);
  if (!load?.billing || load.billing.outside) return;
  if (load.pricing?.isPricingEnabled === false) {
    // Pricing skipped now: the whole load is settled outside Suprah.
    await cancelLoadInvoice(load._id);
    await Load.updateOne({ _id: load._id }, { $set: { 'billing.outside': true } }, { timestamps: false });
    return;
  }
  // Cash is all or nothing: cash on delivery loads collect the whole pay, SuprahPay loads none.
  const pay = carrierPayOf(load.pricing as any);
  if (pay !== null && load.billing.method) {
    const cash = load.billing.method === 'suprahpay' ? 0 : pay;
    await Load.updateOne({ _id: load._id }, { $set: { 'pricing.copCodAmount': cash, 'pricing.balanceAmount': pay - cash } }, { timestamps: false });
  }
  // A dealership load is billed its driver's pay: a new amount replaces an unpaid bill.
  if (load.billing.billTo === 'dealership') await issueLoadInvoice(load._id);
}

/**
 * The load was cancelled: its unpaid automatic invoice is cancelled. A paid
 * one is Suprah's money, so Suprah's super admins are told to refund it and
 * the dealership's admins are told it will be refunded.
 */
export async function afterLoadCancelled(load: {
  _id: unknown;
  organizationId: unknown;
  loadNumber?: string;
  billing?: { invoiceId?: unknown; vehicleInvoiceId?: unknown } | null;
}) {
  try {
    await mentionOpenCarInvoice(load);
    // Taken from the load as it was (Delete Load removes it first).
    if (!load?.billing?.invoiceId) return;
    const result = await cancelInvoice(await Payment.findById(load.billing.invoiceId));
    if (result !== 'paid') return;
    const invoice = await Payment.findById(load.billing.invoiceId).select('amount billedTo invoiceNumber').lean();
    const amount = invoice ? money(Number(invoice.amount) || 0) : 'The shipping payment';
    await notifyOrgAdmins(
      String(load.organizationId),
      'general',
      'Cancelled load was already paid',
      `Load ${load.loadNumber} was cancelled after its shipping was paid (${amount}). Suprah will refund it.`,
      { loadId: String(load._id), route: '/transportation?tab=shipments' },
    );
    await notifySuperAdmins(
      'Refund a cancelled load',
      `Load ${load.loadNumber} was cancelled after its SuprahPay shipping invoice ${invoice?.invoiceNumber ?? ''} was paid (${amount}). Refund it in Stripe's dashboard.`,
    );
  } catch (error) {
    logger.warn({ loadId: String(load?._id), err: (error as Error)?.message }, 'The cancelled load\'s shipping invoice was not settled');
  }
}

/**
 * A cancelled load's car invoice isn't cancelled with it: the customer may
 * still buy the car (and collect it themselves). The dealership's admins are
 * told it's still open, so they cancel it in SuprahPay if the sale is off.
 */
async function mentionOpenCarInvoice(load: { _id: unknown; organizationId: unknown; loadNumber?: string; billing?: { vehicleInvoiceId?: unknown } | null }) {
  if (!load?.billing?.vehicleInvoiceId) return;
  const invoice = await Payment.findById(load.billing.vehicleInvoiceId).select('status invoiceNumber amount').lean();
  if (!invoice || !(AWAITING_PAYMENT_STATUSES as readonly string[]).includes(invoice.status)) return;
  await notifyOrgAdmins(
    String(load.organizationId),
    'general',
    "Cancelled load's car invoice is still open",
    `Load ${load.loadNumber} was cancelled, but the customer's invoice for the car (${invoice.invoiceNumber ?? 'invoice'}, ${money(Number(invoice.amount) || 0)}) is still open. If the sale is off, cancel it in SuprahPay.`,
    { paymentId: String(invoice._id), route: '/billing/payments' },
  );
}

/** What staff see about a load's shipping bill (Edit Load, driver payouts). */
export async function loadBillingSummary(load: { _id: unknown; billing?: any; pricing?: any }) {
  const invoice = load.billing?.invoiceId
    ? await Payment.findById(load.billing.invoiceId).select('status amount billedTo invoiceNumber paidAt').lean()
    : null;
  const gate = driverPayGate(load as any, invoice?.status);
  const car = load.billing?.vehicleInvoiceId
    ? await Payment.findById(load.billing.vehicleInvoiceId).select('status amount invoiceNumber paidAt').lean()
    : null;
  return {
    billing: load.billing ?? null,
    invoice: invoice ? { status: invoice.status, amount: invoice.amount, billedTo: invoice.billedTo, invoiceNumber: invoice.invoiceNumber, paidAt: invoice.paidAt ?? null } : null,
    // The dealership's invoice to the customer for the car (2026-11-26).
    carInvoice: car ? { status: car.status, amount: car.amount, invoiceNumber: car.invoiceNumber, paidAt: car.paidAt ?? null } : null,
    driverPay: gate.ok ? { ok: true as const, amount: gate.amount } : { ok: false as const, code: gate.code, message: gate.message },
  };
}

export { SUPRAH_ISSUER_NAME };
