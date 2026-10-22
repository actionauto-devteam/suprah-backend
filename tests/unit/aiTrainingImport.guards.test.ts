import fs from 'fs';
import path from 'path';
import { emptyValues } from '../../src/services/aiTrainingImportParser';
import {
  IMPORT_RETENTION_DAYS,
  isImportGloballyEnabled,
  parseImportOptions,
  requireImportAccess,
  requireImportAdmin,
  rowFingerprint,
} from '../../src/services/aiTrainingImport.service';

const SRC = path.resolve(__dirname, '../../src');
const IMPORT_FILES = [
  'services/aiTrainingImport.service.ts',
  'services/aiTrainingImportParser.ts',
  'services/aiTrainingImportScreening.ts',
  'controllers/aiTrainingImport.controller.ts',
  'middleware/trainingImportRateLimit.ts',
  'models/AiTrainingImportBatch.model.ts',
  'models/AiTrainingImportItem.model.ts',
  'models/AiTrainingImportContent.model.ts',
];

const FORBIDDEN_MODULES = [
  'services/telnyx.service',
  'services/email.service',
  'services/orgGmail.service',
  'services/communication.service',
  'services/notification.service',
  'services/push.service',
  'services/unifiedPush.service',
  'services/crmPush.service',
  'utils/socketEmitter',
  'utils/safeNotification',
  'services/aiAgent.service',
  'services/aiAgentCoaching.service',
  'services/aiShadowDraft.service',
  'services/aiEmailReply.service',
  'services/aiOperatingMode.service',
  'services/vehicleReengagement.service',
  'controllers/webchat.controller',
  'models/cannedReply.model',
  'models/AiModeChangeLog.model',
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

const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

describe('P1b import safety isolation', () => {
  it.each(IMPORT_FILES)('%s never reaches senders, notifications, schedulers, Alex, Shadow, coaching runtime, modes or canned replies', (file) => {
    const graph = importGraph(file);
    expect(FORBIDDEN_MODULES.filter((mod) => graph.includes(mod))).toEqual([]);
    expect(graph.filter((mod) => mod.startsWith('schedulers/'))).toEqual([]);
  });

  it('import code never calls Gemini, sends messages, or writes org settings, modes, coaching rules, canned replies or Lab scenarios', () => {
    for (const file of IMPORT_FILES) {
      const source = read(file);
      expect({ file, hits: source.match(/createGeminiClient|from 'openai'|classifySafety|chat\.completions|sendSms|sendEmail|notifyOrgAdmins|emitToOrg|AiTrainingScenario|AiTrainingTestRun|CannedReply|aiAgentModes|aiAgentEnabled|Organization\b/g) || [] })
        .toEqual({ file, hits: [] });
      expect({ file, writes: source.match(/AiAgentCoachingRule\.(?:create|insertMany|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|findOneAndDelete|replaceOne)/g) || [] })
        .toEqual({ file, writes: [] });
    }
  });

  it('imports only create drafts: never submitted, approved, published or activated', () => {
    const source = read('services/aiTrainingImport.service.ts');
    expect(source.match(/status: '(?:in_review|approved|published_shadow|published_live)'/g) || []).toEqual([]);
    expect(source).not.toMatch(/submittedVersion|submittedAt|approvedBy|approvedAt|transitionProposal|submitStructuredProposal/);
    expect(source).toMatch(/status: 'draft',\s*\n\s*source: 'podium_import'/);
    expect(source.match(/auditEntry\('(\w+)'/g)).toEqual(["auditEntry('proposal_drafted'", "auditEntry('draft_saved'"]);
  });

  it('the Podium On/Off status is stored as source metadata only and never decides status or activation', () => {
    const source = read('services/aiTrainingImport.service.ts');
    const lines = source.split('\n').filter((line) => /sourceStatus/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/analyzed\.status\s*=|status: '|published|approved|in_review|aiAgent|enabled/);
    expect(source).toMatch(/const \{ notes, sourceRef, location, sourceStatus, \.\.\.content \} = values;/);
  });

  it('the shared outbound safety filter is untouched by the importer', () => {
    for (const file of IMPORT_FILES) expect(read(file)).not.toMatch(/PROHIBITED_PATTERNS|validateOutboundMessage\s*=|aiOutboundSafety'\s*;\s*\n.*export/);
    expect(read('services/aiTrainingImportScreening.ts')).toMatch(/validateOutboundMessage\(sentence\)/);
  });

  it('every import route requires login, the import flag, training, and a manager or admin', () => {
    const routes = read('routes/aiTraining.routes.ts');
    expect(routes).toMatch(/router\.use\(crmAuth\(\)\);[\s\S]*router\.get\('\/imports\/template'/);
    const controller = read('controllers/aiTrainingImport.controller.ts');
    const handlers = controller.match(/export const \w+ = asyncHandler\(async[\s\S]*?\n\}\);/g) || [];
    expect(handlers).toHaveLength(8);
    for (const handler of handlers) expect(handler).toMatch(/await guard\(req\)/);
    expect(controller).toMatch(/requireImportAccess\(ctx\.user\);\s*\n\s*await requireImportEnabled\(ctx\.orgId\);/);
  });
});

describe('P1b import flags, roles, options, keys and retention', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('AI_TRAINING_IMPORT_ENABLED is off unless set to exactly true', () => {
    delete process.env.AI_TRAINING_IMPORT_ENABLED;
    expect(isImportGloballyEnabled()).toBe(false);
    process.env.AI_TRAINING_IMPORT_ENABLED = 'TRUE';
    expect(isImportGloballyEnabled()).toBe(false);
    process.env.AI_TRAINING_IMPORT_ENABLED = 'true';
    expect(isImportGloballyEnabled()).toBe(true);
  });

  it('only managers and admins import; only admins purge', () => {
    expect(() => requireImportAccess({ role: 'employee' })).toThrow('Only managers and admins');
    expect(() => requireImportAccess({ role: 'manager' })).not.toThrow();
    expect(() => requireImportAdmin({ role: 'manager' })).toThrow('Only admins');
    expect(() => requireImportAdmin({ role: 'super_admin' })).not.toThrow();
  });

  it('retention periods match the approved policy', () => {
    expect(IMPORT_RETENTION_DAYS).toEqual({ converted: 180, parked: 365, rejected: 30 });
  });

  it('validates business contacts and refuses personal email providers', () => {
    const options = parseImportOptions({
      businessContacts: [
        { kind: 'phone', value: '+1 (801) 777-1234' },
        { kind: 'email', value: 'Sales@ActionAutoUtah.com' },
        { kind: 'domain', value: 'https://www.actionautoutah.com/inventory' },
      ],
    });
    expect(options.businessContacts).toEqual([
      { kind: 'phone', value: '8017771234' },
      { kind: 'email', value: 'sales@actionautoutah.com' },
      { kind: 'domain', value: 'actionautoutah.com' },
    ]);
    expect(options.mode).toBe('incremental');
    const code = (raw: any) => {
      try { parseImportOptions(raw); } catch (err: any) { return err.errors?.[0]?.code; }
      return 'ok';
    };
    expect(code({ businessContacts: [{ kind: 'email', value: 'dealer@gmail.com' }] })).toBe('personal_email');
    expect(code({ businessContacts: [{ kind: 'phone', value: '12345' }] })).toBe('invalid_phone');
    expect(code({ businessContacts: Array.from({ length: 11 }, () => ({ kind: 'domain', value: 'a.com' })) })).toBe('too_many');
    expect(code({ locationMappings: [{ sourceLabel: 'Orem', locationId: null }, { sourceLabel: 'OREM', locationId: null }] })).toBe('duplicate_mapping');
    expect(code({ locationMappings: [{ sourceLabel: 'Call 801-555-1234', locationId: null }] })).toBe('contact_info');
    expect(parseImportOptions({ locationMappings: [{ sourceLabel: '', locationId: null }] }).locationMappings).toEqual([{ sourceLabel: '', sourceKey: '', locationId: null }]);
    expect(code({ mode: 'replace' })).toBe('invalid_value');
    expect(code({ nameAcknowledgements: [{ rowNumber: 1, fingerprint: 'abc' }] })).toBe('invalid_value');
  });

  it('fingerprints change with content but not with reviewer notes, the Podium reference or the location label', () => {
    const base = { ...emptyValues(), type: 'rule', title: 'Hours', answerOrInstruction: 'Say we open at 9.' };
    const fp = rowFingerprint(base);
    expect(rowFingerprint({ ...base, notes: 'changed', sourceRef: 'X', location: 'Orem', sourceStatus: 'off' })).toBe(fp);
    expect(rowFingerprint({ ...base, answerOrInstruction: 'Say we open at 10.' })).not.toBe(fp);
    expect(rowFingerprint({ ...base, mustAvoid: ['x'] })).not.toBe(fp);
  });
});
