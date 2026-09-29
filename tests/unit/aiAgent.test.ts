const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '50';
process.env.AI_AGENT_CLASSIFIER_TIMEOUT_MS = '50';

import {
  generateAlexReply,
  classifyAlexReplySafety,
  checkReplyCaps,
  ALEX_FALLBACK_MESSAGE,
  AiAgentTranscriptEntry,
} from '../../src/services/aiAgent.service';
import { validateOutboundMessage } from '../../src/utils/aiOutboundSafety';

describe('ALEX_FALLBACK_MESSAGE', () => {
  it('passes the deterministic validator on its own (it is sent with no further checks)', () => {
    expect(validateOutboundMessage(ALEX_FALLBACK_MESSAGE).ok).toBe(true);
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
