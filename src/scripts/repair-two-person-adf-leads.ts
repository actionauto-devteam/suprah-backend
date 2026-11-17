import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import Lead from '../models/lead.model';
import { parseEmailBody } from '../utils/adfParser';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';
import logger from '../utils/logger';

const apply = process.argv.includes('--apply');
const orgArg = process.argv.find((arg) => arg.startsWith('--org='));
const organizationId = orgArg ? orgArg.slice('--org='.length).trim() : undefined;
const EMPTY = { $in: [null, ''] };

const denver = (value: unknown) => (value ? new Date(value as string).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
const month = (value: unknown) => (value ? new Date(value as string).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', year: 'numeric' }) : '-');
const maskName = (first: string, last: string) => `${first}${last ? ` ${last.charAt(0)}.` : ''}`;
const maskPhone = (phone: string) => (phone ? `***${String(phone).replace(/\D/g, '').slice(-4)}` : '-');
const maskEmail = (email: string) => (email ? `${email.charAt(0)}***@${email.split('@')[1] || ''}` : '-');
const isEmpty = (value: unknown) => value === undefined || value === null || String(value).trim() === '';

async function main() {
  logger.level = 'silent';
  if (organizationId && !mongoose.isValidObjectId(organizationId)) throw new Error('--org must be an organization id');
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGODB_URI as string, apply ? {} : { readPreference: 'secondaryPreferred' });
  console.log(apply ? 'APPLY: saving changes.' : 'PREVIEW ONLY: nothing will be saved. Add --apply to save.');

  const filter: Record<string, unknown> = { channel: 'adf', firstName: 'Unknown' };
  if (organizationId) filter.organizationId = new mongoose.Types.ObjectId(organizationId);
  const leads: any[] = await Lead.find(filter)
    .select('_id organizationId firstName lastName email phone body subject senderEmail parsedContent createdAt status combinedInto sourceProvider')
    .sort({ createdAt: 1 })
    .lean();

  const orgNames = new Map<string, string>();
  const orgs = await mongoose.connection.db!.collection('organizations')
    .find({ _id: { $in: [...new Set(leads.map((lead) => String(lead.organizationId)))].map((id) => new mongoose.Types.ObjectId(id)) } })
    .project({ name: 1 })
    .toArray();
  for (const org of orgs) orgNames.set(String(org._id), String(org.name || org._id));

  const skipped = { noAdf: 0, noContactInAdf: 0 };
  const plans: Array<{ lead: any; set: Record<string, string>; guard: Record<string, unknown>; coApplicants: number; matchesOtherLead: boolean }> = [];

  for (const lead of leads) {
    const parsed = await parseEmailBody(String(lead.body || ''), String(lead.subject || ''), String(lead.senderEmail || ''));
    const adf = parsed.adfData;
    if (!adf) { skipped.noAdf++; continue; }
    if (adf.firstName === 'Unknown' && !adf.lastName && !adf.phone && !adf.email) { skipped.noContactInAdf++; continue; }

    const set: Record<string, string> = {};
    const guard: Record<string, unknown> = { _id: lead._id, organizationId: lead.organizationId, firstName: 'Unknown' };
    if (adf.firstName && adf.firstName !== 'Unknown') set.firstName = adf.firstName;
    if (isEmpty(lead.lastName) && adf.lastName) { set.lastName = adf.lastName; guard.lastName = EMPTY; }
    if (isEmpty(lead.phone) && adf.phone) { set.phone = adf.phone; guard.phone = EMPTY; }
    if (isEmpty(lead.email) && adf.email) { set.email = adf.email; guard.email = EMPTY; }
    const summary = adf.requestDateProvided
      ? adf.parsedContent
      : adf.parsedContent.replace(/^Request Date:.*$/m, `Request Date: ${new Date(lead.createdAt).toLocaleString('en-US', { timeZone: 'America/Denver' })}`);
    if (summary && summary !== lead.parsedContent) set.parsedContent = summary;
    if (!set.firstName && !set.phone && !set.email) { skipped.noContactInAdf++; continue; }

    const phoneKey = normalizeIdentityPhone(set.phone || lead.phone);
    const emailKey = normalizeIdentityEmail(set.email || lead.email);
    const sameCustomer = [
      ...(phoneKey ? [{ normalizedPhone: phoneKey }] : []),
      ...(emailKey ? [{ normalizedEmail: emailKey }] : []),
    ];
    const matchesOtherLead = sameCustomer.length
      ? Boolean(await Lead.exists({ organizationId: lead.organizationId, _id: { $ne: lead._id }, $or: sameCustomer }))
      : false;
    plans.push({ lead, set, guard, coApplicants: adf.coApplicants?.length || 0, matchesOtherLead });
  }

  console.log(`ADF leads saved as "Unknown": ${leads.length}`);
  console.log(`Can be fixed from the saved email: ${plans.length}`);
  console.log(`Left as they are: ${skipped.noAdf} with no readable ADF in the saved email, ${skipped.noContactInAdf} where the ADF has no name, phone or email`);

  const tally = (pick: (plan: typeof plans[number]) => string) => {
    const counts = new Map<string, number>();
    for (const plan of plans) counts.set(pick(plan), (counts.get(pick(plan)) || 0) + 1);
    return [...counts.entries()].map(([key, n]) => `${key}: ${n}`).join(' | ');
  };
  console.log('By dealership:', tally((plan) => orgNames.get(String(plan.lead.organizationId)) || String(plan.lead.organizationId)));
  console.log('By month created:', tally((plan) => month(plan.lead.createdAt)));
  console.log('By source:', tally((plan) => plan.lead.sourceProvider || '(none)'));
  console.log('By status:', tally((plan) => String(plan.lead.status || '-')));
  console.log(`Name filled: ${plans.filter((plan) => plan.set.firstName).length}, phone filled: ${plans.filter((plan) => plan.set.phone).length}, email filled: ${plans.filter((plan) => plan.set.email).length}, summary rewritten: ${plans.filter((plan) => plan.set.parsedContent).length}`);
  console.log(`With a co-applicant: ${plans.filter((plan) => plan.coApplicants).length}`);
  console.log(`Combined into another lead already: ${plans.filter((plan) => plan.lead.combinedInto?.leadId).length}`);
  console.log(`Same phone or email as another lead (may show as a duplicate after the fix): ${plans.filter((plan) => plan.matchesOtherLead).length}`);

  console.log('\nLeads (name shortened, phone last 4, email hidden):');
  for (const plan of plans) {
    const name = maskName(plan.set.firstName || plan.lead.firstName, plan.set.lastName || plan.lead.lastName || '');
    console.log(` - ${String(plan.lead._id)} | ${denver(plan.lead.createdAt)} | Unknown -> ${name} | phone ${maskPhone(plan.set.phone || plan.lead.phone)} | email ${maskEmail(plan.set.email || plan.lead.email)} | ${plan.lead.status}${plan.coApplicants ? ' | co-applicant' : ''}${plan.matchesOtherLead ? ' | same contact as another lead' : ''}`);
  }

  if (apply) {
    let saved = 0;
    let changedMeanwhile = 0;
    for (const plan of plans) {
      const updated = await Lead.findOneAndUpdate(plan.guard, { $set: plan.set }, { new: true, timestamps: false });
      if (updated) saved++;
      else changedMeanwhile++;
    }
    console.log(`\nSaved: ${saved}. Skipped because someone edited the lead in the meantime: ${changedMeanwhile}.`);
  }

  console.log(apply ? 'Done. Changes saved.' : 'Preview finished. Nothing was saved.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
