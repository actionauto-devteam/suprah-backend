const openAiCreateMock = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
const groqAudioCreateMock = jest.fn().mockResolvedValue({ text: 'transcribed text' });
const anthropicCreateMock = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

jest.mock('openai', () => {
  return jest.fn().mockImplementation((opts: any) => ({
    chat: { completions: { create: openAiCreateMock } },
    audio: { transcriptions: { create: groqAudioCreateMock } },
    __opts: opts,
  }));
});

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  }));
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
  createReadStream: jest.fn().mockReturnValue({}),
  unlinkSync: jest.fn(),
}));

jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/SupraLeoChat.model', () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/TimeLog.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/SupraSpaceMessage.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/SupraSpaceConversation.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Feed.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/FeedComment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: {} }));

import {
  createGeminiCompletion,
  createAnthropicFallbackCompletion,
  refineMessage,
  transcribeChunk,
} from '../../src/controllers/supraLeo.controller';

function resetLocalUiAcceptanceMode() {
  delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
}

function fakeRes() {
  return { json: jest.fn() } as any;
}

describe('LOCAL_UI_ACCEPTANCE_MODE guards for Autrix (supraLeo.controller.ts)', () => {
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalGroq = process.env.GROQ_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    openAiCreateMock.mockClear();
    groqAudioCreateMock.mockClear();
    anthropicCreateMock.mockClear();
    resetLocalUiAcceptanceMode();
  });

  afterAll(() => {
    process.env.GEMINI_API_KEY = originalGemini;
    process.env.ANTHROPIC_API_KEY = originalAnthropic;
    process.env.GROQ_API_KEY = originalGroq;
    resetLocalUiAcceptanceMode();
  });

  describe('createGeminiCompletion (Gemini + its internal Anthropic/Groq fallback chain)', () => {
    it('blocks and never reaches the Gemini client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(createGeminiCompletion({ model: 'x', messages: [] })).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(openAiCreateMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      const result = await createGeminiCompletion({ model: 'x', messages: [] });
      expect(openAiCreateMock).toHaveBeenCalledTimes(1);
      expect(result.choices[0].message.content).toBe('ok');
    });
  });

  describe('createAnthropicFallbackCompletion', () => {
    it('blocks and never reaches the Anthropic client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(createAnthropicFallbackCompletion({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
        /LOCAL_UI_ACCEPTANCE_MODE/,
      );
      expect(anthropicCreateMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      await createAnthropicFallbackCompletion({ messages: [{ role: 'user', content: 'hi' }] });
      expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('refineMessage (direct Anthropic call, bypasses createAnthropicFallbackCompletion)', () => {
    it('blocks via next(err) and never reaches the Anthropic client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      const req: any = { body: { text: 'please refine this' } };
      const res = fakeRes();
      const next = jest.fn();
      await (refineMessage as any)(req, res, next);
      expect(anthropicCreateMock).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0].message).toMatch(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      const req: any = { body: { text: 'please refine this' } };
      const res = fakeRes();
      const next = jest.fn();
      await (refineMessage as any)(req, res, next);
      expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);
    });
  });

  describe('transcribeChunk (direct Groq audio call)', () => {
    function fakeReqWithFile(): any {
      return { file: { buffer: Buffer.from('fake-audio-bytes'), originalname: 'chunk.webm' } };
    }

    it('blocks (graceful empty-text response, matching this handler\'s own missing-key convention) and never reaches Groq when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      const req = fakeReqWithFile();
      const res = fakeRes();
      const next = jest.fn();
      await (transcribeChunk as any)(req, res, next);
      expect(groqAudioCreateMock).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);
      const payload = res.json.mock.calls[0][0];
      expect(payload.data).toEqual({ text: '' });
      expect(payload.message).toMatch(/blocked/i);
    });

    it('behaves exactly as before when the flag is absent', async () => {
      const req = fakeReqWithFile();
      const res = fakeRes();
      const next = jest.fn();
      await (transcribeChunk as any)(req, res, next);
      expect(groqAudioCreateMock).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      const payload = res.json.mock.calls[0][0];
      expect(payload.data.text).toBe('transcribed text');
    });
  });
});
