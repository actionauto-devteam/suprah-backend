export interface KpiWeights {
  leadsCreated: number;
  leadsContacted: number;
  leadsConverted: number;
  conversionRate: number;
  appointmentsCompleted: number;
  appointmentShowRate: number;
  callsMade: number;
  messagesSent: number;
  followUpsSent: number;
  avgResponseTimeMin: number; // negative weight — lower is better
  transactionsCompleted: number;
  onboardingsCompleted: number;
}

export const DEFAULT_KPI_WEIGHTS: KpiWeights = {
  leadsCreated: 2,
  leadsContacted: 3,
  leadsConverted: 15,
  conversionRate: 0.5,        // per % point
  appointmentsCompleted: 8,
  appointmentShowRate: 0.3,   // per % point
  callsMade: 1,
  messagesSent: 0.5,
  followUpsSent: 2,
  avgResponseTimeMin: -0.5,   // penalty per minute
  transactionsCompleted: 25,
  onboardingsCompleted: 20,
};

export function computeScore(kpis: Partial<Record<keyof KpiWeights, number>>, weights: KpiWeights = DEFAULT_KPI_WEIGHTS): number {
  let score = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const value = kpis[key as keyof KpiWeights] ?? 0;

    if (key === 'avgResponseTimeMin') {
      // Penalty: only applied when response time > 0, cap penalty at -50
      if (value > 0) {
        score += Math.max(weight * value, -50);
      }
    } else {
      score += weight * value;
    }
  }

  return Math.max(0, Math.round(score * 100) / 100);
}

// Period key helpers
export function getPeriodKey(date: Date, type: 'daily' | 'weekly' | 'monthly'): string {
  const d = new Date(date);

  if (type === 'daily') {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  if (type === 'weekly') {
    const dayOfWeek = d.getDay(); // 0 = Sunday
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7)); // ISO Monday
    const week = Math.ceil((((monday.getTime() - new Date(monday.getFullYear(), 0, 1).getTime()) / 86400000) + 1) / 7);
    return `${monday.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  if (type === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  return d.toISOString().slice(0, 10);
}

export function getPeriodRange(periodKey: string, type: 'daily' | 'weekly' | 'monthly'): { start: Date; end: Date } {
  if (type === 'daily') {
    const start = new Date(periodKey);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  if (type === 'weekly') {
    const [year, week] = periodKey.split('-W').map(Number);
    const jan1 = new Date(year, 0, 1);
    const start = new Date(jan1);
    start.setDate(jan1.getDate() + (week - 1) * 7 - jan1.getDay() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }

  // Monthly
  const [year, month] = periodKey.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start, end };
}

// Action → KPI mapping
export const ACTION_KPI_MAP: Record<string, { kpi: string; increment: number }> = {
  lead_created:             { kpi: 'leadsCreated',          increment: 1 },
  lead_contacted:           { kpi: 'leadsContacted',        increment: 1 },
  lead_converted:           { kpi: 'leadsConverted',        increment: 1 },
  lead_replied:             { kpi: 'leadsContacted',        increment: 1 },
  appointment_completed:    { kpi: 'appointmentsCompleted', increment: 1 },
  appointment_created:      { kpi: 'appointmentsCreated',   increment: 1 },
  call_made:                { kpi: 'callsMade',             increment: 1 },
  message_sent:             { kpi: 'messagesSent',          increment: 1 },
  follow_up_sent:           { kpi: 'followUpsSent',         increment: 1 },
  transaction_completed:    { kpi: 'transactionsCompleted', increment: 1 },
  onboarding_completed:     { kpi: 'onboardingsCompleted',  increment: 1 },
};