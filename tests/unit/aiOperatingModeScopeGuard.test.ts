import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function readSrc(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function callBlocks(source: string, callee: string): string[] {
  const blocks: string[] = [];
  let index = source.indexOf(`${callee}(`);
  while (index !== -1) {
    let depth = 0;
    let end = index + callee.length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(index, end + 1));
    index = source.indexOf(`${callee}(`, end);
  }
  return blocks;
}

const allFiles = listTsFiles(SRC).map((file) => ({ file: path.relative(SRC, file).replace(/\\/g, '/'), source: fs.readFileSync(file, 'utf8') }));

describe('AI operating mode — every automated AI send path is guarded', () => {
  it('every SMS sent as the AI agent carries an aiWorkflow so the dispatch guard runs', () => {
    const offenders: string[] = [];
    for (const { file, source } of allFiles) {
      for (const block of callBlocks(source, 'sendStaffAttributedSms')) {
        if (block.startsWith('sendStaffAttributedSms(opts') || /export async function/.test(block)) continue;
        const isAi = /AI_AGENT_ACTOR_ID|['"]ai-agent['"]|log\.finalMessage/.test(block);
        if (isAi && !/aiWorkflow:/.test(block)) offenders.push(`${file}: ${block.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every AI-generated system SMS (vehicle re-engagement) carries an aiWorkflow', () => {
    const source = readSrc('services/vehicleReengagement.service.ts');
    const blocks = callBlocks(source, 'sendAutomatedSms').filter((block) => block.includes('{'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toMatch(/aiWorkflow: 'vehicle_reengagement'/);
  });

  it('every AI email goes out with a dispatch guard', () => {
    const offenders: string[] = [];
    for (const { file, source } of allFiles) {
      for (const block of callBlocks(source, 'sendLeadReplyEmail')) {
        if (/AI_AGENT_ACTOR_ID|['"]ai-agent['"]/.test(block) && !/beforeDispatch/.test(block)) {
          offenders.push(`${file}: ${block.slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the email dispatch guard runs immediately before the Gmail send call', () => {
    const source = readSrc('controllers/lead.controller.ts');
    expect(source).toMatch(/await options\.beforeDispatch\?\.\(\);\s*\n\s*const sendResult = await gmail\.users\.messages\.send\(/);
  });

  it('the SMS dispatch guard runs inside the provider-boundary hook, right before Telnyx', () => {
    const source = readSrc('services/communication.service.ts');
    expect(source).toMatch(/await opts\.beforeDispatch\?\.\(\);\s*\n\s*const sent = await telnyx\.sendSms\(to, body\);/);
  });

  it('the webchat AI reply is mode-checked before it is made visible to the visitor', () => {
    const source = readSrc('controllers/webchat.controller.ts');
    const guardMatch = /await assertAiDispatchAllowed\(\{[^}]*workflow: 'webchat_reply'[^}]*\}\);\s*await claimAiReplyDispatch\(check\);/.exec(source);
    const reveal = source.indexOf('{ $set: { aiDispatchPending: false } }');
    expect(guardMatch).not.toBeNull();
    expect(reveal).toBeGreaterThan(guardMatch!.index);
  });

  it('only known, guarded modules can start AI generation or AI sending', () => {
    const generators = /\b(generateAlexReply|generateProactiveFollowUp|generateAlexEmailReply|generateReengagementMessage|processAlexTurn|processLeadForVehicle|processVehicleForReengagement)\b/;
    const allowed = new Set([
      'services/aiAgent.service.ts',
      'services/communication.service.ts',
      'controllers/webchat.controller.ts',
      'services/aiEmailReply.service.ts',
      'schedulers/aiLeadFollowup.scheduler.ts',
      'services/vehicleReengagement.service.ts',
      'schedulers/vehicleReengagement.scheduler.ts',
      'controllers/demoLab.controller.ts',
      'services/aiShadowDraft.service.ts',
      'services/aiAgentDraft.service.ts',
    ]);
    const unexpected = allFiles.filter(({ file, source }) => generators.test(source) && !allowed.has(file)).map(({ file }) => file);
    expect(unexpected).toEqual([]);
  });

  it('each AI entry point checks the operating mode before generating', () => {
    expect(readSrc('services/communication.service.ts')).toMatch(/workflow: "sms_reply",[\s\S]*?if \(delivery\.action !== "send"\)[\s\S]*?claimAiGeneration\(check\)/);
    expect(readSrc('controllers/webchat.controller.ts')).toMatch(/workflow: 'webchat_reply',[\s\S]*?if \(delivery\.action !== 'send'\)[\s\S]*?claimAiGeneration\(check\)/);
    expect(readSrc('services/aiEmailReply.service.ts')).toMatch(/workflow: 'email_reply'[\s\S]*?if \(delivery\.action !== 'send'\)[\s\S]*?claimAiGeneration\(check\)/);
    expect(readSrc('schedulers/aiLeadFollowup.scheduler.ts')).toMatch(/workflow: 'sms_followup'[\s\S]*?if \(delivery\.action !== 'send'\)[\s\S]*?Lead\.findOneAndUpdate/);
    expect(readSrc('services/vehicleReengagement.service.ts')).toMatch(/workflow: 'vehicle_reengagement'[\s\S]*?skipped_ai_not_live[\s\S]*?generateReengagementMessage\(lead, vehicle\)/);
    expect(readSrc('controllers/vehicleReengagement.controller.ts')).toMatch(/workflow: 'reengagement_send_anyway'[\s\S]*?ApiError\(409/);
    expect(readSrc('services/aiShadowDraft.service.ts')).toMatch(/claimShadowDraft\(input\)[\s\S]*?beginShadowGeneration\([\s\S]*?runWithAiCallObserver\([\s\S]*?completeShadowDraft\(/);
    expect(readSrc('services/aiAgentDraft.service.ts')).toMatch(/export async function generateStaffDraft[\s\S]*?AI_AGENT_NAME_REQUIRED_CODE[\s\S]*?assertLeadOpenForManualSend[\s\S]*?ContactRestrictedError[\s\S]*?withDeadline\(\s*buildDraft\(/);
  });

  it('the Customer Shop Assistant stays isolated from outbound lead messaging', () => {
    const source = readSrc('controllers/customerShopAi.controller.ts');
    expect(source).not.toMatch(/communication\.service|telnyx\.service|email\.service|sendLeadReplyEmail|orgGmail|sendSms|sendEmail|lead\.model|WebChatMessage/);
  });
});
