/**
 * The AI Deal Builder pipeline:
 *   1. Ingest       — documents already in R2
 *   2. Extract      — AI reads docs, fills empty fields, flags conflicts
 *   3. Analyze      — rules engine: amount financed, LTV, DTI, PTI
 *   4. Match        — lender matrix
 *   5. Recommend    — best lenders, rate range, payment
 *   6. Summarize    — plain-English F&I summary
 * Runs in the background; progress is pushed live to the deal workspace.
 */
import { Types } from 'mongoose';
import DealDeskDeal from '../../models/DealDeskDeal.model';
import { DealDeskLender } from '../../models/DealDeskSupport.model';
import { ApiError } from '../../utils/ApiError';
import { analyzeDeal } from './analysis';
import { extractFromDocuments, mergeExtraction, summarizeDeal, aiProvider } from './ai';
import { getSettings, Actor } from './access';
import { transition, postSystemMessage } from './queue';
import { vehicleLabel } from './serialize';
import { emitToUser } from './realtime';

const running = new Set<string>();

function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    o[keys[i]] = o[keys[i]] ?? {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

export async function startAnalysis(dealId: string, actor: Actor) {
  const deal = await DealDeskDeal.findById(dealId);
  if (!deal || String(deal.organizationId) !== actor.orgId) throw new ApiError(404, 'Deal not found');
  if (!['picked_up', 'structured'].includes(deal.stage)) {
    throw new ApiError(409, 'Pick up the deal before running the Deal Builder.');
  }
  if (running.has(dealId)) throw new ApiError(409, 'The Deal Builder is already running on this deal.');

  const processing = await transition(deal, 'processing', actor, {
    action: 'analysis_started',
    systemMessage: `🤖 ${actor.name} started the Deal Builder.`,
  });

  running.add(dealId);
  setImmediate(() => {
    runPipeline(dealId, actor)
      .catch(async (err) => {
        console.error('[deal-desk] pipeline failed', err);
        const fresh = await DealDeskDeal.findById(dealId);
        if (fresh?.stage === 'processing') {
          await transition(fresh, 'picked_up', null, {
            action: 'analysis_failed',
            meta: { error: String(err?.message || err).slice(0, 300) },
            systemMessage: `❌ The Deal Builder hit an error and stopped. The deal is back in review. (${String(err?.message || err).slice(0, 120)})`,
            quietConflict: true,
          });
        }
      })
      .finally(() => running.delete(dealId));
  });

  return processing;
}

async function runPipeline(dealId: string, actor: Actor) {
  const deal = await DealDeskDeal.findById(dealId).lean();
  if (!deal) return;
  const orgId = String(deal.organizationId);
  const settings = await getSettings(orgId);
  const working: any = JSON.parse(JSON.stringify(deal));
  const progress = (step: string) => emitToUser(actor.id, 'deal:progress', { dealId, step });

  /* 2 — extraction */
  let extraction: any = null;
  let mergeSet: Record<string, unknown> = {};
  let conflicts: string[] = [];
  if (settings.aiEnabled && aiProvider() !== 'none' && (deal.documents || []).length) {
    progress('extract');
    try {
      const res = await extractFromDocuments(deal.documents as any);
      if (res) {
        extraction = res.data;
        const merged = mergeExtraction(working, res.data);
        mergeSet = merged.set;
        conflicts = merged.conflicts;
        for (const [path, value] of Object.entries(merged.set)) setPath(working, path, value);
        await postSystemMessage(
          deal,
          `📄 Read ${res.documentsRead} document${res.documentsRead === 1 ? '' : 's'}. Filled ${merged.filled.length} empty field${merged.filled.length === 1 ? '' : 's'}${conflicts.length ? `, found ${conflicts.length} mismatch${conflicts.length === 1 ? '' : 'es'}` : ''}.`,
          'ai',
        );
      }
    } catch (err) {
      console.error('[deal-desk] extraction failed — continuing with entered data', err);
      await postSystemMessage(deal, '⚠️ Could not read the documents automatically. Continuing with the entered data.', 'ai');
    }
  }

  /* 3–5 — rules engine + lender matrix */
  progress('analyze');
  const lenders = await DealDeskLender.find({ organizationId: deal.organizationId, active: true }).lean();
  const result = analyzeDeal(working, lenders as any, {
    defaultTaxRate: settings.defaultTaxRate,
    defaultDocFee: settings.defaultDocFee,
    maxRateMarkup: settings.maxRateMarkup,
  });
  for (const c of conflicts) result.flags.push({ level: 'warn', code: 'doc_conflict', message: c });
  if (conflicts.length) result.readiness = Math.max(0, result.readiness - conflicts.length * 8);

  /* 6 — summary */
  progress('summarize');
  const summary = await summarizeDeal({
    firstName: working.customer?.firstName,
    vehicle: vehicleLabel(working.vehicle),
    analysis: result,
    lenders: result.lenderMatches.slice(0, 4).map((m) => ({ name: m.name, fit: m.fit, rate: m.rate, term: m.term, payment: m.payment, reasons: m.reasons })),
    employmentMonths: working.creditApp?.employmentMonths,
    residenceMonths: working.creditApp?.residenceMonths,
    housingStatus: working.creditApp?.housingStatus,
    tradeIn: !!working.tradeIn?.present,
    downPayment: working.fourSquare?.downPayment,
    desiredPayment: working.fourSquare?.desiredPayment,
  });

  const fresh = await DealDeskDeal.findById(dealId);
  if (!fresh || fresh.stage !== 'processing') return;

  const { lenderMatches, ...analysis } = result;
  await transition(fresh, 'structured', null, {
    set: {
      ...mergeSet,
      analysis: { ...analysis, aiSummary: summary.text, aiProvider: summary.provider, extraction: extraction || undefined },
      lenderMatches: lenderMatches.map((m) => ({ ...m, lenderId: m.lenderId ? new Types.ObjectId(String(m.lenderId)) : undefined })),
    },
    action: 'analysis_completed',
    meta: { readiness: result.readiness, ltv: result.ltv, dti: result.dti, pti: result.pti, provider: summary.provider },
    systemMessage: `✅ Deal structured — readiness ${result.readiness}/100${result.lenderMatches.find((m) => m.fit !== 'fail') ? `, best fit ${result.lenderMatches.find((m) => m.fit !== 'fail')!.name}` : ''}.`,
  });
  progress('done');
}

/** Recompute numbers only (no AI) — used after edits on a structured deal. */
export async function recomputeNumbers(dealId: string) {
  const deal = await DealDeskDeal.findById(dealId);
  if (!deal) return null;
  const settings = await getSettings(String(deal.organizationId));
  const lenders = await DealDeskLender.find({ organizationId: deal.organizationId, active: true }).lean();
  const result = analyzeDeal(deal.toObject(), lenders as any, {
    defaultTaxRate: settings.defaultTaxRate,
    defaultDocFee: settings.defaultDocFee,
    maxRateMarkup: settings.maxRateMarkup,
  });
  const { lenderMatches, ...analysis } = result;
  deal.set('analysis', { ...analysis, aiSummary: deal.analysis?.aiSummary, aiProvider: deal.analysis?.aiProvider, extraction: deal.analysis?.extraction });
  deal.set('lenderMatches', lenderMatches);
  await deal.save();
  return deal;
}
