/**
 * Shapes deals for the API and sockets. The encrypted SSN and storage keys
 * never leave the server.
 */
import { STAGE_LABELS } from './constants';
import { maskSsn } from './pii';

const idOf = (v: any) => (v ? String(v) : undefined);

export function personDTO(p: any) {
  if (!p || (!p.id && !p.name)) return null;
  return { id: idOf(p.id), name: p.name || '' };
}

export function vehicleLabel(v: any): string {
  if (!v) return '';
  const parts = [v.year, v.make, v.model, v.trim].filter(Boolean);
  return parts.length ? parts.join(' ') : v.vin || v.stockNumber || '';
}

export function customerName(c: any): string {
  return [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim() || 'Unnamed customer';
}

/** Compact shape for queue lists, boards and socket broadcasts. */
export function toDealSummary(d: any) {
  const best = (d.lenderMatches || []).find((m: any) => m.fit !== 'fail');
  const flags = d.analysis?.flags || [];
  return {
    id: String(d._id),
    dealNumber: d.dealNumber,
    source: d.source,
    stage: d.stage,
    stageLabel: STAGE_LABELS[d.stage as keyof typeof STAGE_LABELS] || d.stage,
    stageEnteredAt: d.stageEnteredAt,
    customerName: customerName(d.customer),
    vehicleLabel: vehicleLabel(d.vehicle),
    salesperson: personDTO(d.salesperson),
    reviewer: personDTO(d.reviewer),
    financeManager: personDTO(d.financeManager),
    offer: d.offer?.fmId
      ? { fmId: idOf(d.offer.fmId), fmName: d.offer.fmName, offeredAt: d.offer.offeredAt, expiresAt: d.offer.expiresAt, round: d.offer.round }
      : null,
    rotations: (d.offerAttempts || []).filter((a: any) => a.outcome !== 'accepted').length,
    escalated: !!d.escalatedAt,
    amountFinanced: d.analysis?.amountFinanced,
    ltv: d.analysis?.ltv,
    dti: d.analysis?.dti,
    pti: d.analysis?.pti,
    readiness: d.analysis?.readiness,
    estPayment: d.analysis?.estPayment,
    bestLender: best ? { name: best.name, fit: best.fit, rate: best.rate } : null,
    blockingFlags: flags.filter((f: any) => f.level === 'block').length,
    warningFlags: flags.filter((f: any) => f.level === 'warn').length,
    docCount: (d.documents || []).length,
    submittedAt: d.timestamps?.submittedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    lastActivityAt: d.lastActivityAt,
  };
}

/** Full deal for the workspace page. */
export function toDealDetail(d: any) {
  const plain = typeof d.toObject === 'function' ? d.toObject() : d;
  const { ssnEncrypted: _drop, ...creditApp } = plain.creditApp || {};
  return {
    ...toDealSummary(plain),
    customer: plain.customer || {},
    coBuyer: plain.coBuyer || {},
    vehicle: plain.vehicle || {},
    tradeIn: plain.tradeIn || {},
    fourSquare: plain.fourSquare || {},
    creditApp: { ...creditApp, ssnMasked: maskSsn(creditApp.ssnLast4), hasFullSsn: !!_drop },
    documents: (plain.documents || []).map((doc: any) => ({
      id: String(doc._id),
      kind: doc.kind,
      name: doc.name,
      mime: doc.mime,
      size: doc.size,
      uploadedAt: doc.uploadedAt,
      uploadedBy: personDTO(doc.uploadedBy),
      hasExtraction: !!doc.extracted,
    })),
    analysis: plain.analysis
      ? { ...plain.analysis, extraction: undefined, hasExtraction: !!plain.analysis.extraction }
      : null,
    lenderMatches: (plain.lenderMatches || []).map((m: any) => ({ ...m, lenderId: idOf(m.lenderId) })),
    stageHistory: (plain.stageHistory || []).map((h: any) => ({
      stage: h.stage,
      label: STAGE_LABELS[h.stage as keyof typeof STAGE_LABELS] || h.stage,
      enteredAt: h.enteredAt,
      exitedAt: h.exitedAt,
      durationMs: h.durationMs,
      actorName: h.actorName,
    })),
    offerAttempts: (plain.offerAttempts || []).map((a: any) => ({ ...a, fmId: idOf(a.fmId) })),
    timestamps: plain.timestamps || {},
    needsInfoNote: plain.needsInfoNote,
    cancelReason: plain.cancelReason,
    depositRequested: !!plain.depositRequested,
  };
}

export function toMessageDTO(m: any) {
  return {
    id: String(m._id),
    dealId: String(m.dealId),
    kind: m.kind,
    authorId: idOf(m.authorId),
    authorName: m.authorName,
    body: m.body,
    createdAt: m.createdAt,
  };
}
