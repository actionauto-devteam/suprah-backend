import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createTrainingLabLimiter } from '../../src/middleware/trainingLabRateLimit';
import { fictionalDataIssues, parseScenarioInput } from '../../src/services/aiTrainingLab.service';
import {
  LAB_CONFIRM_KEYWORDS,
  LAB_OPT_IN_KEYWORDS,
  LAB_OPT_OUT_KEYWORDS,
  LAB_RESCHEDULE_KEYWORDS,
  normalizeLabSmsCommand,
} from '../../src/utils/trainingLabKeywords';

const SRC = path.resolve(__dirname, '../../src');
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8').replace(/\r\n/g, '\n');

const LAB_ENTRIES = [
  'services/aiTrainingLab.service.ts',
  'services/aiTrainingLabEvaluator.ts',
  'controllers/aiTrainingLab.controller.ts',
  'middleware/trainingLabRateLimit.ts',
];

const FORBIDDEN_MODULES = [
  'services/communication.service',
  'services/telnyx.service',
  'services/email.service',
  'services/gmail.service',
  'services/orgGmail.service',
  'services/aiEmailReply.service',
  'services/aiAgent.service',
  'services/aiHumanAttention.service',
  'services/aiShadowDraft.service',
  'services/aiAgentCoaching.service',
  'services/aiReplyContext.service',
  'services/vehicleInquiryContext.service',
  'services/notification.service',
  'services/vehicleReengagement.service',
  'controllers/webchat.controller',
  'controllers/lead.controller',
  'controllers/communication.controller',
  'models/lead.model',
  'models/communication.model',
  'models/WebChatMessage.model',
  'models/WebChatSession.model',
  'models/Vehicle.model',
  'models/Customer.model',
  'models/AiAgentCoachingRule.model',
  'models/AiAgentLog.model',
  'utils/socketEmitter',
  'utils/safeNotification',
  'utils/aiAgentTask',
  'utils/leadNote',
  'utils/aiAutoPause',
];

function staticImportGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [path.join(SRC, entry)];
  const pattern = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8').replace(/^\s*import\s+type\s[^;]*;/gm, '');
    for (const match of source.matchAll(pattern)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const resolved = [`${base}.ts`, path.join(base, 'index.ts'), base].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return Array.from(seen).map((file) => path.relative(SRC, file).replace(/\\/g, '/').replace(/\.ts$/, ''));
}

describe('Testing Lab import guard', () => {
  it.each(LAB_ENTRIES)('%s never reaches a sender, notifier, generator, real screen, or customer record model', (entry) => {
    const graph = staticImportGraph(entry);
    expect(FORBIDDEN_MODULES.filter((forbidden) => graph.includes(forbidden))).toEqual([]);
  });

  it.each(LAB_ENTRIES)('%s never calls Gemini helpers or live generation', (entry) => {
    const source = read(entry);
    for (const token of ['createGeminiClient', 'createCompletionWithFallback', 'classifyHumanAttention', 'generateAlex', 'classifyAlex', 'classifySafety', 'openai']) {
      expect(source).not.toContain(token);
    }
  });

  it('the lab never writes to proposals or versions', () => {
    const source = read('services/aiTrainingLab.service.ts');
    expect(source).not.toMatch(/AiTrainingPolicy(Version)?\.(create|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|insertMany|bulkWrite)/);
    expect(source).not.toMatch(/AiTrainingAuditLog/);
  });
});

describe('STOP/START and appointment keyword drift detection', () => {
  const live = read('services/communication.service.ts');
  const liveSet = (name: string) => {
    const match = live.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\);`));
    expect(match).not.toBeNull();
    return JSON.parse(`[${match![1]}]`);
  };

  it.each([
    ['CONFIRM_KEYWORDS', LAB_CONFIRM_KEYWORDS],
    ['RESCHEDULE_KEYWORDS', LAB_RESCHEDULE_KEYWORDS],
    ['OPT_OUT_KEYWORDS', LAB_OPT_OUT_KEYWORDS],
    ['OPT_IN_KEYWORDS', LAB_OPT_IN_KEYWORDS],
  ])('the lab copy of %s matches the live SMS code exactly', (name, copy) => {
    expect([...copy]).toEqual(liveSet(name));
  });

  it('the lab normalizer matches the live normalizer exactly', () => {
    const match = live.match(/function normalizeSmsCommand\(body: string\): string \{\n\s*(return [^\n]+)\n\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('return (body || "").trim().toUpperCase().replace(/[.!?]+$/, "");');
    expect(read('utils/trainingLabKeywords.ts')).toContain(match![1]);
    expect(normalizeLabSmsCommand('  stop!! ')).toBe('STOP');
  });

  it('the live SMS flow still consumes appointment keywords before Alex even without an appointment', () => {
    expect(live).toMatch(/const appointment = await findAppointmentForReply\(orgId, from\);\n\s*if \(!appointment\) return true;/);
  });
});

describe('fictional-data validation', () => {
  it.each([
    ['real phone', 'Call me at 801-555-1234', 'real_phone'],
    ['real phone with country code', 'My cell is +1 (385) 246-7788', 'real_phone'],
    ['real email', 'email riley@gmail.com please', 'real_email'],
    ['link', 'see https://www.mydealer.com/car', 'real_link'],
    ['vin', 'VIN 1HGCM82633A004352', 'vin'],
    ['record id', 'lead 507f1f77bcf86cd799439011', 'record_id'],
    ['mock directive', 'hello [mock:timeout]', 'mock_directive'],
  ])('rejects %s', (_label, text, code) => {
    expect(fictionalDataIssues('message', text).errors.map((issue) => issue.code)).toContain(code);
  });

  it.each([
    'Call me at 801-555-0142',
    'email riley@example.com',
    'see https://example.com/car',
    'Should I get a sedan or an SUV for a family of five?',
  ])('accepts fictional data: %s', (text) => {
    expect(fictionalDataIssues('message', text).errors).toEqual([]);
  });

  it('warns about street addresses', () => {
    expect(fictionalDataIssues('message', 'I live at 1200 Main Street').warnings.map((issue) => issue.code)).toEqual(['street_address']);
  });

  it('validates every scenario field and rejects malformed input', () => {
    const parsed = parseScenarioInput({
      title: 'Test', channel: 'fax', message: '', turns: [{ from: 'robot', body: 'x' }, 'bad'],
      expectation: { handling: 'maybe', mustAsk: 'not a list' }, tags: [1], customerName: 'Call 801-555-9999',
    });
    expect(parsed.errors.map((issue) => issue.field)).toEqual(expect.arrayContaining([
      'channel', 'expectation.handling', 'turns.0', 'turns.1', 'message', 'expectation.mustAsk', 'tags.0', 'customerName',
    ]));
  });

  it.each([null, 'text', 42, []])('rejects a missing or malformed scenario %p', (raw) => {
    expect(parseScenarioInput(raw).errors.map((issue) => issue.code)).toContain('invalid_type');
  });

  it('enforces size limits', () => {
    const parsed = parseScenarioInput({
      title: 'x'.repeat(121), channel: 'sms', message: 'x'.repeat(501), expectation: { handling: 'ai_handles', mustInclude: Array.from({ length: 9 }, (_, i) => `item ${i}`) },
      turns: Array.from({ length: 9 }, () => ({ from: 'customer', body: 'hi' })),
    });
    expect(parsed.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(['too_long', 'too_many']));
  });
});

describe('Testing Lab rate limit', () => {
  const original = process.env.SKIP_RATE_LIMIT;
  afterAll(() => { process.env.SKIP_RATE_LIMIT = original; });

  it('limits each user separately and returns 429 past the limit', async () => {
    delete process.env.SKIP_RATE_LIMIT;
    const app = express();
    app.use((req: any, _res, next) => { req.orgId = 'org-1'; req.crmUser = { _id: req.header('x-user') }; next(); });
    app.post('/lab', createTrainingLabLimiter({ windowMs: 60_000, max: 2 }), (_req, res) => { res.json({ ok: true }); });
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
    await request(app).post('/lab').set('x-user', 'a').expect(200);
    await request(app).post('/lab').set('x-user', 'a').expect(200);
    const blocked = await request(app).post('/lab').set('x-user', 'a').expect(429);
    expect(blocked.body.message).toContain('Too many Testing Lab requests');
    await request(app).post('/lab').set('x-user', 'b').expect(200);
  });

  it('honors SKIP_RATE_LIMIT like the other limiters', async () => {
    process.env.SKIP_RATE_LIMIT = 'true';
    const app = express();
    app.use((req: any, _res, next) => { req.crmUser = { _id: 'c' }; next(); });
    app.post('/lab', createTrainingLabLimiter({ windowMs: 60_000, max: 1 }), (_req, res) => { res.json({ ok: true }); });
    await request(app).post('/lab').expect(200);
    await request(app).post('/lab').expect(200);
  });

  it('every lab write route uses the write limiter and the check route has its own limiter', () => {
    const routes = read('routes/aiTraining.routes.ts');
    for (const route of ["post('/lab/scenarios'", "put('/lab/scenarios/:id'", "post('/lab/scenarios/:id/archive'", "post('/lab/scenarios/:id/restore'", "post('/lab/runs'", "post('/lab/runs/batch'"]) {
      expect(routes).toContain(`router.${route}, trainingLabWriteLimiter,`);
    }
    expect(routes).toContain("router.post('/lab/scenarios/check', trainingLabCheckLimiter,");
    expect(routes.match(/router\.(post|put|patch|delete)\('\/lab\//g)?.length).toBe(7);
  });
});
