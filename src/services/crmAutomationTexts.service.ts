import CrmAutomationRun from '../models/CrmAutomationRun.model';

const TEXT_STEP_TYPES = new Set(['send_message', 'send_review_invitation', 'send_appointment_confirmation']);

export function stepsSendText(steps: any[] | undefined): boolean {
  return (steps || []).some((step) => {
    if (TEXT_STEP_TYPES.has(step?.type)) return true;
    if (step?.type !== 'branch') return false;
    const config = step.config || {};
    return (config.paths || []).some((path: any) => stepsSendText(path?.steps)) || stepsSendText(config.else?.steps);
  });
}

export async function automationForNoShowText(appointment: any): Promise<string | null> {
  if (process.env.CRM_AUTOMATIONS_ENABLED !== 'true') return null;
  if (!appointment?._id || !appointment?.organizationId) return null;
  const runs: any[] = await CrmAutomationRun.find({
    organizationId: String(appointment.organizationId),
    appointmentId: String(appointment._id),
    event: 'appointment_no_show',
    mode: 'live',
    status: { $ne: 'filtered' },
  }).select('automationName steps').lean();
  const texting = runs.find((run) => stepsSendText(run.steps));
  return texting ? String(texting.automationName || 'An automation') : null;
}
