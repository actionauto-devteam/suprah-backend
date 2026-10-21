import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');
const ENTRY = path.join(SRC, 'services/aiShadowDraft.service.ts');

const FORBIDDEN_MODULES = [
  'services/communication.service',
  'services/telnyx.service',
  'services/email.service',
  'services/gmail.service',
  'services/orgGmail.service',
  'services/aiEmailReply.service',
  'services/notification.service',
  'services/vehicleReengagement.service',
  'controllers/webchat.controller',
  'controllers/lead.controller',
  'controllers/communication.controller',
  'utils/socketEmitter',
  'utils/safeNotification',
  'utils/aiAgentTask',
  'utils/leadNote',
  'utils/aiAutoPause',
];

function stripTypeOnlyImports(source: string): string {
  return source.replace(/^\s*import\s+type\s[^;]*;/gm, '').replace(/^\s*export\s+type\s[^;]*;/gm, '');
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base + '.ts', path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function staticImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  const pattern = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = stripTypeOnlyImports(fs.readFileSync(file, 'utf8'));
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveRelative(file, match[1]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

const relative = (file: string) => path.relative(SRC, file).replace(/\\/g, '/').replace(/\.ts$/, '');

describe('Shadow draft service import guard', () => {
  const graph = Array.from(staticImportGraph(ENTRY)).map(relative);

  it('never reaches any send, notification, task, note, or live-orchestration module, even transitively', () => {
    const reached = FORBIDDEN_MODULES.filter((forbidden) => graph.includes(forbidden));
    expect(reached).toEqual([]);
  });

  it('actually walks the real dependencies it relies on', () => {
    for (const expected of ['services/aiAgent.service', 'services/aiReplyContext.service', 'services/vehicleInquiryContext.service', 'utils/aiOutboundSafety', 'utils/vehicleMatch']) {
      expect(graph).toContain(expected);
    }
  });

  const shadowSource = fs.readFileSync(ENTRY, 'utf8');
  const contextSource = fs.readFileSync(path.join(SRC, 'services/aiReplyContext.service.ts'), 'utf8');

  it('never calls the live Alex orchestrator or marks coaching as used', () => {
    for (const source of [shadowSource, contextSource]) {
      expect(source).not.toMatch(/\bprocessAlexTurn\b/);
      expect(source).not.toMatch(/\bmarkAiCoachingUsed\b/);
      expect(source).not.toMatch(/\bsendSmsFromUser\b|\bsendAutomatedSms\b|\bsendStaffAttributedSms\b|\bsendEmail\b/);
      expect(source).not.toMatch(/\bemitToOrg\b|\bemitToUser\b|\bnotifyUsers\b|\bnotifyOrgAdmins\b/);
    }
  });

  it('only reads live communication, webchat, lead, and coaching records', () => {
    const writes = /\b(CommunicationMessage|WebChatMessage|WebChatSession|Conversation|Lead|AiAgentCoachingRule|AiAgentTask|Notification|AiAgentLog)\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|bulkWrite|replaceOne|findOneAndDelete)\(/;
    expect(shadowSource).not.toMatch(writes);
    expect(contextSource).not.toMatch(writes);
  });
});
