import { evaluateScenario, LAB_ENGINE_VERSION, verdictFor, wordOverlap } from '../../src/services/aiTrainingLabEvaluator';
import { parseStructuredRule } from '../../src/services/aiTrainingRules.service';
import type { ScenarioContent } from '../../src/models/AiTrainingScenario.model';

const rule = (overrides: Record<string, unknown> = {}) => parseStructuredRule({
  title: 'Sedan versus SUV questions',
  channels: ['sms', 'webchat', 'email'],
  intent: 'is deciding between a sedan and an SUV',
  triggers: ['asks whether a sedan or SUV fits their family'],
  handling: 'ask_clarifying',
  instruction: 'Ask about family size and typical driving before suggesting a body style.',
  requiredQuestions: ['How many people usually ride with you?'],
  mustInclude: ['offer a test drive'],
  mustAvoid: ['guessing what is on the lot'],
  ...overrides,
}).rule;

const scenario = (overrides: Partial<ScenarioContent> = {}, expectation: Partial<ScenarioContent['expectation']> = {}): ScenarioContent => ({
  title: 'Family of five',
  channel: 'sms',
  turns: [],
  message: 'Should I get a sedan or an SUV for my family of five?',
  flags: { hasUpcomingAppointment: false, previouslyOptedOut: false },
  expectation: { handling: 'ask_clarifying', mustAsk: [], mustInclude: [], mustAvoid: [], ...expectation },
  tags: [],
  archived: false,
  ...overrides,
});

const GOOD_REPLY = 'Great question! How many people usually ride with you? I can also set up a test drive so you can offer feedback on both.';
const byId = (result: ReturnType<typeof evaluateScenario>, id: string) => result.checks.find((check) => check.id === id)!;

describe('engine identity', () => {
  it('has a versioned engine identifier', () => {
    expect(LAB_ENGINE_VERSION).toMatch(/^training-lab-\d+\.\d+\.\d+$/);
  });

  it('is deterministic for the same input', () => {
    const input = { rule: rule(), scenario: scenario(), reply: { text: GOOD_REPLY } };
    expect(evaluateScenario(input)).toEqual(evaluateScenario(input));
  });
});

describe('mandatory safety before Alex', () => {
  it.each(['STOP', 'stop', 'Stop!', 'UNSUBSCRIBE', 'START'])('SMS "%s" is handled before Alex (keyword rule)', (message) => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ message }, { handling: 'safety_stop' }) });
    expect(result.predictedPath).toBe('safety_stop_certain');
    expect(byId(result, 'safety.sms_opt_keyword')).toMatchObject({ status: 'pass', method: 'keyword_rule' });
  });

  it.each(['YES', 'ok', 'Cancel.'])('SMS appointment keyword "%s" stops Alex even without an appointment', (message) => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ message }) });
    expect(result.predictedPath).toBe('safety_stop_certain');
    const check = byId(result, 'safety.sms_appointment_keyword');
    expect(check.status).toBe('fail');
    expect(check.message).toContain('even without an upcoming appointment');
    expect(result.verdict).toBe('failed');
  });

  it('keywords only apply to SMS', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ channel: 'webchat', message: 'STOP' }) });
    expect(result.checks.some((check) => check.id.startsWith('safety.sms_'))).toBe(false);
  });

  it('a previous SMS opt-out stops Alex', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ flags: { hasUpcomingAppointment: false, previouslyOptedOut: true } }, { handling: 'safety_stop' }) });
    expect(result.predictedPath).toBe('safety_stop_certain');
    expect(byId(result, 'safety.sms_previous_opt_out').status).toBe('pass');
  });

  it('the local attention check is labeled as a local approximation, never as the real Gemini screen', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ message: 'Let me talk to a real person.' }, { handling: 'safety_stop' }) });
    const check = byId(result, 'safety.local_attention_screen');
    expect(check).toMatchObject({ status: 'pass', method: 'local_mock_screening' });
    expect(check.message).toContain('Local approximation only. The real check uses Gemini and can decide differently.');
    expect(result.predictedPath).toBe('safety_stop_likely');
  });

  it('a likely safety stop that the scenario did not expect is a warning, not a definitive fail', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ message: 'Are you a bot? Should a family pick a sedan or an SUV?' }) });
    expect(byId(result, 'safety.local_attention_screen').status).toBe('warning');
    expect(byId(result, 'rule.protected_conflict').status).toBe('warning');
  });

  it('the rule-versus-safety warning only appears when the rule plausibly applies', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ message: 'STOP' }, { handling: 'safety_stop' }) });
    expect(result.checks.some((check) => check.id === 'rule.protected_conflict')).toBe(false);
  });

  it('an expected stop that no local check confirms is a warning', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({}, { handling: 'safety_stop' }) });
    expect(byId(result, 'safety.expected_stop')).toMatchObject({ status: 'warning', method: 'approximate' });
    expect(result.verdict).toBe('needs_review');
  });
});

describe('rule handling', () => {
  it('passes when the rule handling matches the expectation', () => {
    expect(byId(evaluateScenario({ rule: rule(), scenario: scenario() }), 'rule.handling')).toMatchObject({ status: 'pass', method: 'deterministic' });
  });

  it('fails when the rule handling differs', () => {
    const result = evaluateScenario({ rule: rule({ handling: 'ai_handles' }), scenario: scenario() });
    expect(byId(result, 'rule.handling')).toMatchObject({ status: 'fail' });
    expect(result.verdict).toBe('failed');
  });

  it('marks an older instruction-only proposal as not evaluated rather than passing', () => {
    const legacy = parseStructuredRule({ title: 'Legacy', instruction: 'Ask for the preferred time first.' }).rule;
    const result = evaluateScenario({ rule: legacy, scenario: scenario(), reply: { text: GOOD_REPLY } });
    expect(byId(result, 'rule.handling').status).toBe('not_evaluated');
    expect(byId(result, 'rule.likely_applies').status).toBe('not_evaluated');
    expect(result.verdict).not.toBe('checks_passed');
  });

  it('rule matching is approximate and says so', () => {
    const check = byId(evaluateScenario({ rule: rule(), scenario: scenario() }), 'rule.likely_applies');
    expect(check.method).toBe('approximate');
    expect(check.message).toContain('not proof of what Alex would say');
  });

  it('little overlap produces a warning, never a fail', () => {
    const check = byId(evaluateScenario({ rule: rule(), scenario: scenario({ message: 'What time do you open Saturday?' }) }), 'rule.likely_applies');
    expect(check.status).toBe('warning');
  });
});

describe('sample replies', () => {
  it('rules-only runs cannot claim a pass: reply checks are not evaluated and the verdict is incomplete', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario() });
    expect(result.checks.filter((check) => check.group === 'reply').every((check) => check.status === 'not_evaluated' && !check.optional)).toBe(true);
    expect(result.verdict).toBe('incomplete');
  });

  it('a good reply passes the checks, and the result is flagged as including approximate matches', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text: GOOD_REPLY } });
    expect(result.counts.fail).toBe(0);
    expect(result.verdict).toBe('checks_passed');
    expect(result.includesApproximate).toBe(true);
  });

  it('the existing safety filter blocks prices and financing', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text: 'It is $24,999 with 0% APR. How many people usually ride with you?' } });
    expect(byId(result, 'reply.safety_filter')).toMatchObject({ status: 'fail', method: 'existing_safety_filter' });
  });

  it('the email filter is used for email scenarios', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ channel: 'email' }), reply: { text: 'We can talk through financing options on your visit. How many people usually ride with you?' } });
    expect(byId(result, 'reply.safety_filter').message).toContain('financing/payment language');
  });

  it.each([
    'I am a real person, not a bot! How many people usually ride with you?',
    "I'm human, how many people usually ride with you?",
    "I'm not a bot. How many people usually ride with you?",
  ])('a reply claiming to be human fails: %s', (text) => {
    expect(byId(evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text } }), 'reply.honest_identity').status).toBe('fail');
  });

  it('an honest virtual-assistant reply passes the identity check', () => {
    const text = "I'm Alex, a virtual assistant. How many people usually ride with you?";
    expect(byId(evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text } }), 'reply.honest_identity').status).toBe('pass');
  });

  it('a reply claiming to be human fails (original case)', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text: 'I am a real person, not a bot! How many people usually ride with you?' } });
    expect(byId(result, 'reply.honest_identity').status).toBe('fail');
  });

  it('missing questions, missing includes and included avoids are flagged', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text: 'We have plenty of SUVs, and I am guessing what is on the lot right now.' } });
    expect(byId(result, 'reply.question.0').status).toBe('fail');
    expect(byId(result, 'reply.include.0').status).toBe('fail');
    expect(byId(result, 'reply.avoid.0').status).toBe('fail');
    expect(byId(result, 'reply.handling_shape').status).toBe('fail');
  });

  it('scenario expectations add to the rule\'s own lists', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({}, { mustAsk: ['What is your budget?'] }), reply: { text: GOOD_REPLY } });
    expect(byId(result, 'reply.question.1').label).toBe('Asks: What is your budget?');
  });

  it('long SMS replies are a warning', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario(), reply: { text: `${GOOD_REPLY} ${'More details. '.repeat(30)}` } });
    expect(byId(result, 'reply.length').status).toBe('warning');
  });

  it('a handoff scenario checks for handoff wording, approximately', () => {
    const escalate = rule({ handling: 'escalate', requiredQuestions: [], escalation: { when: 'Asked for financing', handoffReason: 'Financing question' } });
    const result = evaluateScenario({ rule: escalate, scenario: scenario({}, { handling: 'escalate' }), reply: { text: 'Good question! Someone from our team will reach out shortly to help.' } });
    expect(byId(result, 'reply.handling_shape')).toMatchObject({ status: 'pass', method: 'approximate' });
  });

  it('when Alex would never reply, reply checks are optional not-evaluated and do not block the verdict', () => {
    const result = evaluateScenario({ rule: rule(), scenario: scenario({ message: 'STOP' }, { handling: 'safety_stop' }), reply: { text: GOOD_REPLY } });
    const reply = result.checks.filter((check) => check.group === 'reply');
    expect(reply.every((check) => check.status === 'not_evaluated' && check.optional)).toBe(true);
    expect(result.verdict).toBe('checks_passed');
  });
});

describe('verdict rules', () => {
  const check = (status: any, extra: Record<string, unknown> = {}) => ({ id: 'x', group: 'rule' as const, label: 'x', method: 'deterministic' as const, message: 'x', status, ...extra });
  it('any fail → failed', () => expect(verdictFor([check('pass'), check('fail'), check('warning')]).verdict).toBe('failed'));
  it('warnings → needs_review', () => expect(verdictFor([check('pass'), check('warning')]).verdict).toBe('needs_review'));
  it('required not-evaluated → incomplete', () => expect(verdictFor([check('pass'), check('not_evaluated')]).verdict).toBe('incomplete'));
  it('optional not-evaluated does not block', () => expect(verdictFor([check('pass'), check('not_evaluated', { optional: true })]).verdict).toBe('checks_passed'));
  it('approximate passes are flagged', () => expect(verdictFor([check('pass', { method: 'approximate' })]).includesApproximate).toBe(true));
  it('deterministic-only passes are not flagged', () => expect(verdictFor([check('pass')]).includesApproximate).toBe(false));
});

describe('word overlap', () => {
  it('ignores filler words and simple plurals', () => {
    expect(wordOverlap('How many people ride with you?', 'how many people usually ride along')).toBe(1);
    expect(wordOverlap('offer test drives', 'we can offer a test drive')).toBe(1);
    expect(wordOverlap('', 'anything')).toBe(0);
  });
});
