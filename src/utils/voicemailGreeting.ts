import Organization from '../models/Organization.model';

export function buildVoicemailGreeting(dealerName: string): string {
  return `Thank you for calling ${dealerName}. All of our team members are busy right now. Please leave a message after the tone, and we will call you back as soon as we can.`;
}

export async function defaultVoicemailGreeting(organizationId: string): Promise<string> {
  const org: any = await Organization.findById(organizationId).select('name').lean().catch(() => null);
  return buildVoicemailGreeting(org?.name || 'Your Dealership');
}
