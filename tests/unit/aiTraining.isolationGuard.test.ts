import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');

const GENERATION_ENTRY_POINTS = [
  'services/aiAgent.service.ts',
  'services/aiAgentCoaching.service.ts',
  'services/aiShadowDraft.service.ts',
  'services/communication.service.ts',
  'controllers/webchat.controller.ts',
  'services/aiEmailReply.service.ts',
  'schedulers/aiLeadFollowup.scheduler.ts',
  'services/vehicleReengagement.service.ts',
];

const TRAINING_MODULES = [
  'models/AiTrainingPolicy.model',
  'models/AiTrainingPolicyVersion.model',
  'models/AiTrainingAuditLog.model',
  'models/AiDraftEvaluation.model',
  'services/aiTraining.service',
  'services/aiTrainingRules.service',
  'services/aiTrainingLab.service',
  'services/aiTrainingLabEvaluator',
  'models/AiTrainingScenario.model',
  'models/AiTrainingScenarioRevision.model',
  'models/AiTrainingTestRun.model',
  'controllers/aiTrainingLab.controller',
  'controllers/aiTraining.controller',
  'models/AiTrainingImportBatch.model',
  'models/AiTrainingImportItem.model',
  'models/AiTrainingImportContent.model',
  'services/aiTrainingImport.service',
  'services/aiTrainingImportParser',
  'services/aiTrainingImportScreening',
  'services/aiTrainingSafetyGate',
  'controllers/aiTrainingImport.controller',
  'services/aiCoachingAudit.service',
  'models/AiKnowledgeEntry.model',
  'models/AiKnowledgeEntryVersion.model',
  'models/AiKnowledgeAuditLog.model',
  'models/AiKnowledgeKeyLock.model',
  'services/aiKnowledgeBase.service',
  'services/aiKnowledgeSafety',
  'controllers/aiKnowledgeBase.controller',
  'routes/aiKnowledgeBase.routes',
  'models/AiKnowledgeVerifiedDetail.model',
  'services/aiKnowledgeVerifiedDetails.service',
  'services/aiKnowledgeInvalidation.service',
  'services/aiKnowledgeAudit',
  'services/aiKnowledgeCommon',
  'services/aiKnowledgeImport.service',
];

function stripTypeOnly(source: string): string {
  return source.replace(/^\s*import\s+type\s[^;]*;/gm, '').replace(/^\s*export\s+type\s[^;]*;/gm, '');
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base + '.ts', path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [path.join(SRC, entry)];
  const pattern = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of stripTypeOnly(fs.readFileSync(file, 'utf8')).matchAll(pattern)) {
      const resolved = resolveRelative(file, match[1]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return Array.from(seen).map((file) => path.relative(SRC, file).replace(/\\/g, '/').replace(/\.ts$/, ''));
}

describe('Phase 3A isolation: training data can never reach AI generation', () => {
  it.each(GENERATION_ENTRY_POINTS)('%s never imports training proposals, versions, audit, or evaluations', (entry) => {
    const graph = importGraph(entry);
    expect(TRAINING_MODULES.filter((mod) => graph.includes(mod))).toEqual([]);
  });

  it('coaching runtime still reads only active AiAgentCoachingRule documents', () => {
    const source = fs.readFileSync(path.join(SRC, 'services/aiAgentCoaching.service.ts'), 'utf8');
    expect(source).toMatch(/AiAgentCoachingRule\.find\(\{[\s\S]*?status: 'active'/);
    expect(source).not.toMatch(/AiTraining|AiDraftEvaluation/);
  });

  it('the coaching controller routes non-managers to proposals before any rule is created', () => {
    const source = fs.readFileSync(path.join(SRC, 'controllers/aiAgentCoaching.controller.ts'), 'utf8').replace(/\r\n/g, '\n');
    const routing = source.indexOf('if (!isManager(user)) {\n    const { policy, created } = await submitCoachingAsProposal(');
    const create = source.indexOf('const rule = await AiAgentCoachingRule.create(');
    expect(routing).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(routing);
    expect(source.slice(routing, create)).toMatch(/return;\n  \}/);
    expect(source).not.toMatch(/QA_MUTATION/);
  });
});
