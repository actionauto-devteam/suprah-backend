import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import AiTrainingScenario, { SCENARIO_CHANNELS } from '../models/AiTrainingScenario.model';
import AiTrainingTestRun, { TEST_RUN_RETENTION_DAYS } from '../models/AiTrainingTestRun.model';
import { canReviewTraining, requireTrainingEnabled, titleSearchFilter, trainingRole } from '../services/aiTraining.service';
import {
  LAB_LIMITS,
  canManageScenario,
  createScenario,
  listScenarioRevisions,
  loadScenario,
  parseScenarioInput,
  runScenarioBatch,
  runScenarioTest,
  runVisibilityFilter,
  setScenarioArchived,
  updateScenario,
} from '../services/aiTrainingLab.service';
import { LAB_ENGINE_VERSION } from '../services/aiTrainingLabEvaluator';

function context(req: Request): { orgId: string; user: any } {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  return { orgId, user };
}

function pageParams(req: Request) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiError(400, 'page must be a whole number from 1 to 1000');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be a whole number from 1 to 100');
  return { page, limit };
}

function serializeScenario(scenario: any, user: any) {
  return {
    id: String(scenario._id),
    title: scenario.title,
    channel: scenario.channel,
    customerName: scenario.customerName || undefined,
    vehicleInterest: scenario.vehicleInterest || undefined,
    turns: (scenario.turns || []).map((turn: any) => ({ from: turn.from, body: turn.body })),
    message: scenario.message,
    flags: { hasUpcomingAppointment: Boolean(scenario.flags?.hasUpcomingAppointment), previouslyOptedOut: Boolean(scenario.flags?.previouslyOptedOut) },
    expectation: {
      handling: scenario.expectation?.handling,
      mustAsk: scenario.expectation?.mustAsk || [],
      mustInclude: scenario.expectation?.mustInclude || [],
      mustAvoid: scenario.expectation?.mustAvoid || [],
      notes: scenario.expectation?.notes || undefined,
    },
    tags: scenario.tags || [],
    archived: Boolean(scenario.archived),
    archivedAt: scenario.archivedAt || undefined,
    revision: scenario.revision,
    createdBy: scenario.createdBy ? { name: scenario.createdBy.name, role: scenario.createdBy.role } : null,
    lastEditedByName: scenario.lastEditedBy?.name || undefined,
    isMine: scenario.createdBy?.userId === String(user._id),
    canManage: canManageScenario(user, scenario),
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
  };
}

function serializeRevision(row: any) {
  return {
    revision: row.revision,
    action: row.action,
    content: row.content,
    changeNote: row.changeNote || undefined,
    createdByName: row.createdBy?.name,
    createdAt: row.createdAt,
  };
}

function serializeRun(run: any) {
  return {
    id: String(run._id),
    policyId: String(run.policyId),
    policyVersion: run.policyVersion,
    policyStatusAtRun: run.policyStatusAtRun,
    policyTitle: run.policyTitle,
    ruleFormat: run.ruleFormat,
    scenarioId: String(run.scenarioId),
    scenarioRevision: run.scenarioRevision,
    scenarioTitle: run.scenarioSnapshot?.title,
    scenarioSnapshot: run.scenarioSnapshot,
    channel: run.channel,
    mode: run.mode,
    reply: run.reply || undefined,
    engineVersion: run.engineVersion,
    checks: run.checks || [],
    counts: run.counts,
    verdict: run.verdict,
    includesApproximate: Boolean(run.includesApproximate),
    runByName: run.runBy?.name,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
  };
}

export const getLabStatus = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const [active, total] = await Promise.all([
    AiTrainingScenario.countDocuments({ organizationId: orgId, archived: false }),
    AiTrainingScenario.countDocuments({ organizationId: orgId }),
  ]);
  res.json(new ApiResponse(200, {
    engineVersion: LAB_ENGINE_VERSION,
    retentionDays: TEST_RUN_RETENTION_DAYS,
    canTestAllProposals: canReviewTraining(trainingRole(user)),
    aiSimulationAvailable: false,
    scenarios: { active, total, activeLimit: LAB_LIMITS.activeScenariosPerOrg },
  }, 'Testing Lab status'));
});

export const listScenarios = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { page, limit } = pageParams(req);
  const filter: Record<string, unknown> = { organizationId: orgId, archived: req.query.archived === 'true' };
  if (req.query.channel) {
    if (!(SCENARIO_CHANNELS as readonly string[]).includes(String(req.query.channel))) throw new ApiError(400, 'Unknown channel filter');
    filter.channel = String(req.query.channel);
  }
  if (req.query.mine === 'true') filter['createdBy.userId'] = String(user._id);
  Object.assign(filter, titleSearchFilter(req.query.q));
  const [rows, total] = await Promise.all([
    AiTrainingScenario.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AiTrainingScenario.countDocuments(filter),
  ]);
  res.json(new ApiResponse(200, {
    scenarios: rows.map((row) => serializeScenario(row, user)),
    page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
  }, 'Scenarios'));
});

export const checkScenario = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = context(req);
  await requireTrainingEnabled(orgId);
  const { errors, warnings } = parseScenarioInput(req.body?.scenario);
  res.json(new ApiResponse(200, { errors, warnings }, 'Scenario check'));
});

export const createScenarioHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { scenario, warnings } = await createScenario({ organizationId: orgId, user, scenario: req.body?.scenario });
  res.status(201).json(new ApiResponse(201, { scenario: serializeScenario(scenario.toObject(), user), warnings }, 'Scenario saved'));
});

export const getScenario = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const scenario = await loadScenario(orgId, String(req.params.id));
  const revisions = await listScenarioRevisions(orgId, String(scenario._id));
  res.json(new ApiResponse(200, { scenario: serializeScenario(scenario.toObject(), user), revisions: revisions.map(serializeRevision) }, 'Scenario'));
});

export const updateScenarioHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { scenario, warnings } = await updateScenario({
    organizationId: orgId, scenarioId: String(req.params.id), user, scenario: req.body?.scenario,
    expectedRevision: req.body?.expectedRevision, changeNote: req.body?.changeNote,
  });
  res.json(new ApiResponse(200, { scenario: serializeScenario(scenario.toObject(), user), warnings }, 'Scenario updated'));
});

function archiveHandler(archived: boolean) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { orgId, user } = context(req);
    await requireTrainingEnabled(orgId);
    const scenario = await setScenarioArchived({
      organizationId: orgId, scenarioId: String(req.params.id), user, archived,
      expectedRevision: req.body?.expectedRevision, changeNote: req.body?.changeNote,
    });
    res.json(new ApiResponse(200, { scenario: serializeScenario(scenario.toObject(), user) }, archived ? 'Scenario archived' : 'Scenario restored'));
  });
}

export const archiveScenarioHandler = archiveHandler(true);
export const restoreScenarioHandler = archiveHandler(false);

export const createRunHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const run = await runScenarioTest({
    organizationId: orgId, user, policyId: req.body?.policyId, version: req.body?.version,
    scenarioId: req.body?.scenarioId, mode: req.body?.mode, reply: req.body?.reply,
  });
  res.status(201).json(new ApiResponse(201, serializeRun(run.toObject()), 'Test finished'));
});

export const createBatchRunHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const runs = await runScenarioBatch({
    organizationId: orgId, user, policyId: req.body?.policyId, version: req.body?.version,
    scenarioIds: req.body?.scenarioIds, mode: req.body?.mode, reply: req.body?.reply,
  });
  res.status(201).json(new ApiResponse(201, { runs: runs.map((run: any) => serializeRun(run.toObject())) }, 'Tests finished'));
});

export const listRuns = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { page, limit } = pageParams(req);
  const filter = runVisibilityFilter(orgId, user);
  for (const key of ['policyId', 'scenarioId'] as const) {
    if (req.query[key]) {
      if (!mongoose.isValidObjectId(String(req.query[key]))) throw new ApiError(400, `${key} must be a valid id`);
      filter[key] = String(req.query[key]);
    }
  }
  if (req.query.version) {
    const version = Number(req.query.version);
    if (!Number.isInteger(version) || version < 1) throw new ApiError(400, 'version must be a whole number');
    filter.policyVersion = version;
  }
  const [rows, total] = await Promise.all([
    AiTrainingTestRun.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AiTrainingTestRun.countDocuments(filter),
  ]);
  res.json(new ApiResponse(200, {
    runs: rows.map(serializeRun), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), retentionDays: TEST_RUN_RETENTION_DAYS,
  }, 'Test results'));
});

export const getRun = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  if (!mongoose.isValidObjectId(String(req.params.id))) throw new ApiError(404, 'Test result not found');
  const run = await AiTrainingTestRun.findOne({ _id: String(req.params.id), ...runVisibilityFilter(orgId, user) }).lean();
  if (!run) throw new ApiError(404, 'Test result not found');
  res.json(new ApiResponse(200, serializeRun(run), 'Test result'));
});
