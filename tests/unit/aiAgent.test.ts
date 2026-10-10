const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '50';
process.env.AI_AGENT_CLASSIFIER_TIMEOUT_MS = '50';

const mockLogCreate = jest.fn().mockResolvedValue({});
jest.mock('../../src/models/AiAgentLog.model', () => ({
  __esModule: true,
  default: { create: mockLogCreate },
}));

const mockMarkAiCoachingUsed = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/aiAgentCoaching.service', () => ({
  markAiCoachingUsed: mockMarkAiCoachingUsed,
}));

import {
  generateAlexReply,
  classifyAlexReplySafety,
  checkReplyCaps,
  processAlexTurn,
  ALEX_FALLBACK_MESSAGE,
  AiAgentTranscriptEntry,
  AiAgentTurnContext,
} from '../../src/services/aiAgent.service';
import { validateOutboundMessage } from '../../src/utils/aiOutboundSafety';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';

describe('ALEX_FALLBACK_MESSAGE', () => {
  it('passes the deterministic validator on its own (it is sent with no further checks)', () => {
    expect(validateOutboundMessage(ALEX_FALLBACK_MESSAGE).ok).toBe(true);
  });
});

describe('generateAlexReply — first-response introduction, language, and honest disclosure', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Sure thing!' } }] });
  });

  const baseOpts = {
    agentName: 'Alex',
    dealerName: 'Action Auto',
    customerFirstName: 'Jordan',
    leadVehicleInterest: '2022 Toyota Camry',
    transcript: [] as AiAgentTranscriptEntry[],
    channel: 'webchat' as const,
  };

  function systemPromptFromLastCall(): string {
    const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    return call.messages.find((m: any) => m.role === 'system').content;
  }

  it('instructs a brief, natural introduction when isFirstReply is true', async () => {
    await generateAlexReply({ ...baseOpts, isFirstReply: true });
    const prompt = systemPromptFromLastCall();
    expect(prompt).toMatch(/first message to this customer/i);
    expect(prompt).toMatch(/briefly and naturally introduce yourself/i);
  });

  it('instructs no reintroduction when isFirstReply is false', async () => {
    await generateAlexReply({ ...baseOpts, isFirstReply: false });
    const prompt = systemPromptFromLastCall();
    expect(prompt).toMatch(/already spoken with this customer/i);
    expect(prompt).toMatch(/do not reintroduce yourself/i);
    expect(prompt).not.toMatch(/briefly and naturally introduce yourself/i);
  });

  it('defaults to the no-reintroduction instruction when isFirstReply is omitted (backward compatible)', async () => {
    await generateAlexReply(baseOpts);
    const prompt = systemPromptFromLastCall();
    expect(prompt).toMatch(/do not reintroduce yourself/i);
  });

  it('always includes an explicit honest-disclosure instruction naming the configured agent name', async () => {
    await generateAlexReply({ ...baseOpts, agentName: 'Riley', isFirstReply: false });
    const prompt = systemPromptFromLastCall();
    expect(prompt).toMatch(/directly asks whether you are a bot/i);
    expect(prompt).toContain('Riley, a virtual assistant');
    expect(prompt).toMatch(/never claim to be human/i);
  });

  it('always includes an instruction to reply in the customer\'s language, including Spanish', async () => {
    await generateAlexReply({ ...baseOpts, isFirstReply: true });
    const prompt = systemPromptFromLastCall();
    expect(prompt).toMatch(/same language the customer is using/i);
    expect(prompt).toMatch(/including spanish/i);
  });

  it('introduction instruction uses the configured agent and dealer names, not hardcoded values', async () => {
    await generateAlexReply({ ...baseOpts, agentName: 'Riley', dealerName: 'Lakeview Motors', isFirstReply: true });
    const prompt = systemPromptFromLastCall();
    expect(prompt).toContain("you're Riley with Lakeview Motors");
  });
});

describe('generateAlexReply — handoff marker parsing', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  const baseOpts = {
    agentName: 'Alex',
    dealerName: 'Action Auto',
    customerFirstName: 'Jordan',
    leadVehicleInterest: '2022 Toyota Camry',
    transcript: [] as AiAgentTranscriptEntry[],
    channel: 'webchat' as const,
  };

  it('returns clean text with no handoffReason when no marker is present', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Sure, come by anytime this week!' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe('Sure, come by anytime this week!');
    expect(result.handoffReason).toBeUndefined();
  });

  it('strips a well-formed [[HANDOFF: reason]] marker and surfaces the reason', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: "I'm not 100% sure if that trim is still on the lot, let me check.\n[[HANDOFF: confirm trim availability]]",
        },
      }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe("I'm not 100% sure if that trim is still on the lot, let me check.");
    expect(result.handoffReason).toBe('confirm trim availability');
  });

  it('is not fooled by an unterminated or malformed marker (treats it as plain text)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Sounds good [[HANDOFF: missing closing bracket' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe('Sounds good [[HANDOFF: missing closing bracket');
    expect(result.handoffReason).toBeUndefined();
  });

  it('falls back to a generic handoff reason when the marker body is empty', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'One sec, let me find out.\n[[HANDOFF:]]' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe('One sec, let me find out.');
    expect(result.handoffReason).toBe('Needs human follow-up');
  });

  it('returns an error, not a rejection, when the provider call times out', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the model produces only a handoff marker and no reply text', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '[[HANDOFF: nothing to say]]' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBeNull();
  });

  it('injects bounded team coaching below the hard system rules', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Can you share what time works best for you?' } }],
    });

    await generateAlexReply({
      ...baseOpts,
      coachingNotes: ["Ask for the customer's preferred appointment time before offering a schedule."],
    });

    const messages = mockCreate.mock.calls[0][0].messages;
    expect(messages[0].content).toContain('Relevant active dealership coaching for this situation');
    expect(messages[0].content).toContain("Ask for the customer's preferred appointment time");
    expect(messages[0].content).toContain('If any coaching conflicts');
  });
});

describe('generateAlexReply — milestone marker parsing', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  const baseOpts = {
    agentName: 'Alex',
    dealerName: 'Action Auto',
    customerFirstName: 'Jordan',
    leadVehicleInterest: '2022 Toyota Camry',
    transcript: [] as AiAgentTranscriptEntry[],
    channel: 'webchat' as const,
  };

  it('strips a well-formed [[MILESTONE: ...]] marker and surfaces the note', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: "Great, you're all set for Saturday at 10am!\n[[MILESTONE: Booked a test drive for Saturday 10am]]",
        },
      }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe("Great, you're all set for Saturday at 10am!");
    expect(result.milestoneNote).toBe('Booked a test drive for Saturday 10am');
    expect(result.handoffReason).toBeUndefined();
  });

  it('is not fooled by an unterminated or malformed marker (treats it as plain text)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Sounds good [[MILESTONE: missing closing bracket' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe('Sounds good [[MILESTONE: missing closing bracket');
    expect(result.milestoneNote).toBeUndefined();
  });

  it('ignores an empty milestone marker body (never fires a blank milestone note)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'All booked!\n[[MILESTONE:]]' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.text).toBe('All booked!\n[[MILESTONE:]]');
    expect(result.milestoneNote).toBeUndefined();
  });

  it('never returns both a handoffReason and a milestoneNote for the same reply', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: "I'm not sure about that trim, let me check.\n[[HANDOFF: confirm trim availability]]",
        },
      }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.handoffReason).toBe('confirm trim availability');
    expect(result.milestoneNote).toBeUndefined();
  });

  it('returns no marker fields for a routine reply with neither marker present', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Sure, come by anytime this week!' } }],
    });
    const result = await generateAlexReply(baseOpts);
    expect(result.handoffReason).toBeUndefined();
    expect(result.milestoneNote).toBeUndefined();
  });
});

describe('classifyAlexReplySafety', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns SAFE only on an exact "SAFE" response', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    await expect(classifyAlexReplySafety('hello')).resolves.toBe('SAFE');
  });

  it('treats a literal "UNSAFE" response as unsafe, not a SAFE substring match', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'UNSAFE' } }] });
    await expect(classifyAlexReplySafety('hello')).resolves.toBe('UNSAFE');
  });

  it('resolves to ERROR on timeout rather than hanging', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(classifyAlexReplySafety('hello')).resolves.toBe('ERROR');
  });
});

describe('checkReplyCaps', () => {
  const staff = (body: string): AiAgentTranscriptEntry => ({ from: 'staff', body });
  const ai = (body: string): AiAgentTranscriptEntry => ({ from: 'ai', body });
  const customer = (body: string): AiAgentTranscriptEntry => ({ from: 'customer', body });

  it('is not capped with an empty transcript and zero replies sent today', () => {
    expect(checkReplyCaps({ transcript: [], repliesSentToday: 0 }).capped).toBe(false);
  });

  it('caps once the daily reply count is reached', () => {
    const result = checkReplyCaps({ transcript: [], repliesSentToday: 40, maxPerDay: 40 });
    expect(result.capped).toBe(true);
    expect(result.reason).toMatch(/daily/i);
  });

  it('counts trailing AI turns since the last staff turn, ignoring customer turns in between', () => {
    const transcript = [
      staff('welcome'),
      customer('hi'),
      ai('reply 1'),
      customer('question'),
      ai('reply 2'),
      customer('another question'),
      ai('reply 3'),
    ];
    const result = checkReplyCaps({ transcript, repliesSentToday: 0, maxConsecutive: 3 });
    expect(result.capped).toBe(true);
    expect(result.reason).toMatch(/consecutive/i);
  });

  it('resets the consecutive count after a staff turn', () => {
    const transcript = [
      ai('reply 1'),
      ai('reply 2'),
      ai('reply 3'),
      staff('I can take it from here'),
      customer('ok thanks'),
      ai('reply 4'),
    ];
    const result = checkReplyCaps({ transcript, repliesSentToday: 0, maxConsecutive: 3 });
    expect(result.capped).toBe(false);
  });
});

describe('processAlexTurn — mid-generation human-takeover check', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockLogCreate.mockClear();
    mockMarkAiCoachingUsed.mockClear();
  });

  function buildCtx(overrides: Partial<AiAgentTurnContext> = {}): AiAgentTurnContext {
    return {
      organizationId: 'org-1',
      leadId: 'lead-1',
      channel: 'sms',
      conversationId: 'conv-1',
      agentName: 'Alex',
      dealerName: 'Action Auto',
      customerFirstName: 'Jordan',
      leadVehicleInterest: '2022 Toyota Camry',
      transcript: [],
      repliesSentToday: 0,
      send: jest.fn().mockResolvedValue({ messageId: 'msg-1' }),
      notifyHandoff: jest.fn().mockResolvedValue(undefined),
      notifyMilestone: jest.fn().mockResolvedValue(undefined),
      onCapExceeded: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('sends normally when isPausedNow resolves false', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sure, see you then!' } }] });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    const isPausedNow = jest.fn().mockResolvedValue(false);
    const ctx = buildCtx({ isPausedNow });

    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledWith('Sure, see you then!');
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  it('logs and marks coaching usage only after a send succeeds', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: ['64b000000000000000000001'], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'What time works best for you?' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    const ctx = buildCtx({
      isPausedNow: jest.fn().mockResolvedValue(false),
      coachingNotes: ['Ask for preferred appointment time.'],
      coachingRuleIds: ['64b000000000000000000001'],
    });

    await processAlexTurn(ctx);

    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sent',
        coachingRuleIds: ['64b000000000000000000001'],
        coachingRuleIdsApplied: ['64b000000000000000000001'],
        coachingFirstDraftVerdict: 'compliant',
        coachingFinalVerdict: 'compliant',
      }),
    );
    expect(mockMarkAiCoachingUsed).toHaveBeenCalledWith(['64b000000000000000000001']);
  });

  it('skips the send and logs status:skipped when isPausedNow resolves true, and never calls notifyHandoff', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sure, see you then!' } }] });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    const isPausedNow = jest.fn().mockResolvedValue(true);
    const ctx = buildCtx({ isPausedNow });

    await processAlexTurn(ctx);

    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.notifyHandoff).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', failureReason: expect.stringMatching(/human took over/i) }),
    );
  });

  it('is backward compatible when isPausedNow is omitted entirely', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sure, see you then!' } }] });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    const ctx = buildCtx();
    delete (ctx as any).isPausedNow;

    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  it('also skips the fallback send when isPausedNow resolves true after a generation failure', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => {})); // times out -> no draft
    const isPausedNow = jest.fn().mockResolvedValue(true);
    const ctx = buildCtx({ isPausedNow });

    await processAlexTurn(ctx);

    expect(ctx.send).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('also skips the fallback send when isPausedNow resolves true after an UNSAFE classification', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sure, see you then!' } }] });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'UNSAFE' } }] });
    const isPausedNow = jest.fn().mockResolvedValue(true);
    const ctx = buildCtx({ isPausedNow });

    await processAlexTurn(ctx);

    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('does not call isPausedNow when the reply cap is already exceeded', async () => {
    const isPausedNow = jest.fn().mockResolvedValue(false);
    const ctx = buildCtx({ isPausedNow, repliesSentToday: 999999 });

    await processAlexTurn(ctx);

    expect(isPausedNow).not.toHaveBeenCalled();
    expect(ctx.onCapExceeded).toHaveBeenCalledTimes(1);
  });

  it('still invokes notifyHandoff with a single (reason) argument on a normal handoff-marker reply', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Let me check on that.\n[[HANDOFF: confirm trim availability]]" } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    const isPausedNow = jest.fn().mockResolvedValue(false);
    const ctx = buildCtx({ isPausedNow });

    await processAlexTurn(ctx);

    expect(ctx.notifyHandoff).toHaveBeenCalledTimes(1);
    expect(ctx.notifyHandoff).toHaveBeenCalledWith('confirm trim availability');
  });

  it('selects generic relevant coaching and applies only those rules', async () => {
    const rule = {
      id: '64b000000000000000000011',
      instruction: 'Ask one clarifying question before offering an appointment slot.',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const unrelated = {
      id: '64b000000000000000000012',
      instruction: 'Use a warmer greeting for Spanish-language webchat leads.',
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [rule.id], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'What time works best for you?' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });

    const ctx = buildCtx({ coachingRules: [unrelated, rule] });
    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith('What time works best for you?');
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      coachingRuleIdsConsidered: [unrelated.id, rule.id],
      coachingRuleIdsRelevant: [rule.id],
      coachingRuleIdsApplied: [rule.id],
      coachingFinalVerdict: 'compliant',
    }));
  });

  it('does not apply irrelevant coaching to the reply', async () => {
    const rule = {
      id: '64b000000000000000000013',
      instruction: 'When a customer asks about service hours, mention Saturday service.',
    };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Happy to help with that.' } }] });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });

    const ctx = buildCtx({ coachingRules: [rule] });
    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith('Happy to help with that.');
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      coachingRuleIdsRelevant: [],
      coachingRuleIdsApplied: [],
      coachingFinalVerdict: 'not_applicable',
    }));
  });

  it('allows multiple non-conflicting relevant coaching rules to coexist', async () => {
    const askTime = { id: '64b000000000000000000014', instruction: 'Ask for the preferred time first.' };
    const concise = { id: '64b000000000000000000015', instruction: 'Keep appointment replies under two sentences.' };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [askTime.id, concise.id], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'What time works best for you?' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });

    const ctx = buildCtx({ coachingRules: [askTime, concise] });
    await processAlexTurn(ctx);

    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      coachingRuleIdsApplied: [askTime.id, concise.id],
    }));
  });

  it('suppresses older conflicting coaching when the relevance resolver chooses newer-wins', async () => {
    const older = { id: '64b000000000000000000016', instruction: 'Offer morning appointments first.' };
    const newer = { id: '64b000000000000000000017', instruction: 'Ask the customer for their preferred time before offering slots.' };
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            relevantRuleIds: [newer.id, older.id],
            suppressed: [{ ruleId: older.id, reason: 'Newer relevant coaching supersedes this instruction.' }],
          }),
        },
      }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'What time works best for you?' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });

    const ctx = buildCtx({ coachingRules: [newer, older] });
    await processAlexTurn(ctx);

    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      coachingRuleIdsRelevant: [newer.id, older.id],
      coachingRuleIdsApplied: [newer.id],
      coachingRuleIdsSuppressed: [older.id],
      coachingSuppressionReasons: [{ ruleId: older.id, reason: 'Newer relevant coaching supersedes this instruction.' }],
    }));
  });

  it('fails closed when the relevance classifier returns malformed output', async () => {
    const rule = { id: '64b000000000000000000018', instruction: 'Ask a clarifying question first.' };
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    const ctx = buildCtx({ coachingRules: [rule] });

    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith(ALEX_FALLBACK_MESSAGE);
    expect(ctx.notifyHandoff).toHaveBeenCalledWith(expect.stringMatching(/relevance/i));
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'fallback_sent',
      coachingFinalVerdict: 'error',
    }));
  });

  it('regenerates once when the first draft violates applied coaching', async () => {
    const rule = {
      id: '64b000000000000000000019',
      instruction: "next time, don't say yes yet. just say you need to confirm this first",
    };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [rule.id], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Yes, absolutely, you're more than welcome to bring your kids along!" } }],
    });
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: 'violates',
            violatedRuleIds: [rule.id],
            reason: 'The draft answers before confirming.',
          }),
        },
      }],
    });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Let me confirm that with the team first, and I will follow up shortly.' } }],
    });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });

    const ctx = buildCtx({
      coachingRules: [rule],
      transcript: [{ from: 'customer', body: 'Can I bring my kids?' }],
    });
    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith('Let me confirm that with the team first, and I will follow up shortly.');
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      coachingFirstDraftVerdict: 'violates',
      coachingFinalVerdict: 'compliant',
      coachingRegenerated: true,
      coachingViolatedRuleIds: [],
    }));
  });

  it('falls back when regeneration still violates applied coaching', async () => {
    const rule = { id: '64b000000000000000000020', instruction: 'Confirm with the team before answering policy questions.' };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [rule.id], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Sure, that is fine.' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'violates', violatedRuleIds: [rule.id], reason: 'Did not confirm first.' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Yes, that should be okay.' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'violates', violatedRuleIds: [rule.id], reason: 'Still answers without confirming.' }) } }],
    });

    const ctx = buildCtx({ coachingRules: [rule] });
    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith(ALEX_FALLBACK_MESSAGE);
    expect(ctx.notifyHandoff).toHaveBeenCalledWith('Still answers without confirming.');
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'fallback_sent',
      coachingFinalVerdict: 'violates',
      coachingRegenerated: true,
    }));
  });

  it('keeps hard deterministic safety above coaching even when coaching compliance passes', async () => {
    const rule = { id: '64b000000000000000000021', instruction: 'Answer directly when customers ask about discounts.' };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [rule.id], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'We can give you 10% off today.' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });

    const ctx = buildCtx({ coachingRules: [rule] });
    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith(ALEX_FALLBACK_MESSAGE);
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'fallback_sent',
      blockedReason: expect.stringMatching(/percent-off|discount/i),
      coachingFinalVerdict: 'compliant',
    }));
  });

  it('applies the same coaching path for webchat turns', async () => {
    const rule = { id: '64b000000000000000000022', instruction: 'Ask a clarifying question before scheduling.' };
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ relevantRuleIds: [rule.id], suppressed: [] }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'What day works best for you?' } }] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: 'compliant', violatedRuleIds: [], reason: '' }) } }],
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });

    const ctx = buildCtx({ channel: 'webchat', sessionId: 'session-1', conversationId: undefined, coachingRules: [rule] });
    await processAlexTurn(ctx);

    expect(ctx.send).toHaveBeenCalledWith('What day works best for you?');
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'webchat',
      sessionId: 'session-1',
      coachingRuleIdsApplied: [rule.id],
    }));
  });

  it('does not send a fallback or handoff if dispatch rejects a normal reply after the pause recheck', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'What day works best for you?' } }] });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    const ctx = buildCtx({ send: jest.fn().mockRejectedValue(new AiReplySuppressedError()) });
    await processAlexTurn(ctx);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.notifyHandoff).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', failureReason: 'Alex reply suppressed at dispatch' }));
  });

  it('does not send another fallback or handoff if dispatch rejects a fallback', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'We offer 10% off.' } }] });
    const ctx = buildCtx({ send: jest.fn().mockRejectedValue(new AiReplySuppressedError()) });
    await processAlexTurn(ctx);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.notifyHandoff).not.toHaveBeenCalled();
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', failureReason: 'Alex fallback suppressed at dispatch' }));
  });
});

describe('generateAlexReply / classifyAlexReplySafety — Gemini QA-mode phone wiring', () => {
  const DEMO_PHONE = '+18015550142';
  const REAL_LOOKING_PHONE = '+18015551234';
  const ORIGINAL_ENV = {
    LOCAL_UI_ACCEPTANCE_MODE: process.env.LOCAL_UI_ACCEPTANCE_MODE,
    LOCAL_GEMINI_QA_MODE: process.env.LOCAL_GEMINI_QA_MODE,
    MONGODB_URI: process.env.MONGODB_URI,
  };

  const baseOpts = {
    agentName: 'Alex',
    dealerName: 'Action Auto',
    customerFirstName: 'Jordan',
    leadVehicleInterest: '2022 Toyota Camry',
    transcript: [] as AiAgentTranscriptEntry[],
    channel: 'sms' as const,
  };

  beforeEach(() => {
    mockCreate.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
  });

  it('generateAlexReply refuses to call Gemini under LOCAL_UI_ACCEPTANCE_MODE when no phone is supplied, even with the QA flag on', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    const result = await generateAlexReply({ ...baseOpts });
    expect(result.text).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('generateAlexReply refuses to call Gemini for a real-looking (non-demo-pattern) phone, even with the QA flag on', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    const result = await generateAlexReply({ ...baseOpts, phone: REAL_LOOKING_PHONE });
    expect(result.text).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('generateAlexReply calls Gemini when every QA-mode condition is verified and the phone is a genuine demo number', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Hi there!' } }] });
    const result = await generateAlexReply({ ...baseOpts, phone: DEMO_PHONE });
    expect(result.text).toBe('Hi there!');
    expect(mockCreate).toHaveBeenCalled();
  });

  it('classifyAlexReplySafety resolves to ERROR under the QA exception when the phone is missing or non-demo, without calling Gemini', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    await expect(classifyAlexReplySafety('hello there')).resolves.toBe('ERROR');
    await expect(classifyAlexReplySafety('hello there', REAL_LOOKING_PHONE)).resolves.toBe('ERROR');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('classifyAlexReplySafety calls Gemini when the phone is a genuine demo number under the QA exception', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_GEMINI_QA_MODE = 'true';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/suprah_dev';
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    await expect(classifyAlexReplySafety('hello there', DEMO_PHONE)).resolves.toBe('SAFE');
    expect(mockCreate).toHaveBeenCalled();
  });

  it('outside LOCAL_UI_ACCEPTANCE_MODE, both functions are fully unaffected by the phone argument (regression guard for every existing caller/test in this file)', async () => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Hi there!' } }] });
    const result = await generateAlexReply({ ...baseOpts, phone: REAL_LOOKING_PHONE });
    expect(result.text).toBe('Hi there!');
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'SAFE' } }] });
    await expect(classifyAlexReplySafety('hello there', REAL_LOOKING_PHONE)).resolves.toBe('SAFE');
  });
});
