jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  AiCallObserver,
  AiCallBudgetExceededError,
  createCompletionWithFallback,
  runWithAiCallObserver,
} from '../../src/utils/aiOutboundSafety';

const completion = (model = 'gemini-a', usage: any = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }) => ({
  model,
  usage,
  choices: [{ message: { content: 'ok' } }],
});

function fakeClient(create: jest.Mock): any {
  return { chat: { completions: { create } } };
}

function observer(overrides: Partial<AiCallObserver> = {}): AiCallObserver {
  return { maxCalls: 5, phase: 'generation', calls: [], ...overrides };
}

describe('AI call observer', () => {
  it('leaves the live path untouched when no observer is active', async () => {
    const create = jest.fn().mockResolvedValue(completion());
    await createCompletionWithFallback(fakeClient(create), { model: 'gemini-a' }, 'gemini-b', 'Test');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toHaveLength(1);
  });

  it('passes a cancellation signal, disables SDK retries, and records model, tokens, and latency', async () => {
    const create = jest.fn().mockResolvedValue(completion('gemini-served'));
    const obs = observer({ signal: new AbortController().signal, perCallTimeoutMs: 5000 });
    await runWithAiCallObserver(obs, () => createCompletionWithFallback(fakeClient(create), { model: 'gemini-a' }, 'gemini-b', 'Test'));
    expect(create.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal), maxRetries: 0 });
    expect(obs.calls).toEqual([
      { phase: 'generation', model: 'gemini-served', promptTokens: 11, completionTokens: 4, totalTokens: 15, latencyMs: expect.any(Number), ok: true },
    ]);
  });

  it('records a failed call without usage', async () => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const obs = observer();
    await expect(runWithAiCallObserver(obs, () => createCompletionWithFallback(fakeClient(create), { model: 'gemini-a' }, 'gemini-b', 'Test'))).rejects.toThrow('boom');
    expect(obs.calls).toEqual([{ phase: 'generation', model: 'gemini-a', latencyMs: expect.any(Number), ok: false }]);
  });

  it('enforces the call budget, including the 404 fallback retry', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
      .mockResolvedValue(completion('gemini-b'));
    const obs = observer({ maxCalls: 2 });
    const client = fakeClient(create);
    await runWithAiCallObserver(obs, () => createCompletionWithFallback(client, { model: 'gemini-a' }, 'gemini-b', 'Test'));
    expect(obs.calls.map((call) => [call.model, call.ok])).toEqual([['gemini-a', false], ['gemini-b', true]]);
    await expect(runWithAiCallObserver(obs, () => createCompletionWithFallback(client, { model: 'gemini-a' }, 'gemini-b', 'Test')))
      .rejects.toBeInstanceOf(AiCallBudgetExceededError);
    expect(obs.budgetExhausted).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refuses to start a call once the request was cancelled', async () => {
    const create = jest.fn().mockResolvedValue(completion());
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const obs = observer({ signal: controller.signal });
    await expect(runWithAiCallObserver(obs, () => createCompletionWithFallback(fakeClient(create), { model: 'gemini-a' }, 'gemini-b', 'Test'))).rejects.toThrow('cancelled');
    expect(create).not.toHaveBeenCalled();
    expect(obs.calls).toHaveLength(0);
  });

  it('aborts a hung request when the per-call timeout passes', async () => {
    let seen: AbortSignal | undefined;
    const create = jest.fn().mockImplementation((_body: any, req: any) => {
      seen = req.signal;
      return new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const obs = observer({ perCallTimeoutMs: 30 });
    await expect(runWithAiCallObserver(obs, () => createCompletionWithFallback(fakeClient(create), { model: 'gemini-a' }, 'gemini-b', 'Test'))).rejects.toThrow('aborted');
    expect(seen!.aborted).toBe(true);
  });

  it('keeps concurrent observers isolated from each other', async () => {
    const create = jest.fn().mockImplementation((body: any) => new Promise((resolve) => setTimeout(() => resolve(completion(body.model)), 10)));
    const client = fakeClient(create);
    const first = observer({ phase: 'one' });
    const second = observer({ phase: 'two' });
    await Promise.all([
      runWithAiCallObserver(first, () => createCompletionWithFallback(client, { model: 'model-one' }, 'x', 'Test')),
      runWithAiCallObserver(second, async () => {
        await createCompletionWithFallback(client, { model: 'model-two' }, 'x', 'Test');
        await createCompletionWithFallback(client, { model: 'model-two' }, 'x', 'Test');
      }),
    ]);
    expect(first.calls.map((call) => call.model)).toEqual(['model-one']);
    expect(second.calls.map((call) => call.model)).toEqual(['model-two', 'model-two']);
  });

  it('a shadow run being cancelled never touches a live call running at the same time', async () => {
    let shadowSignal: AbortSignal | undefined;
    const create = jest.fn().mockImplementation((body: any, req?: any) => {
      if (body.model === 'shadow-model') {
        shadowSignal = req.signal;
        return new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(new Error('shadow aborted'))));
      }
      return new Promise((resolve) => setTimeout(() => resolve(completion('live-model')), 30));
    });
    const client = fakeClient(create);
    const controller = new AbortController();
    const shadow = runWithAiCallObserver(observer({ signal: controller.signal }), () =>
      createCompletionWithFallback(client, { model: 'shadow-model' }, 'x', 'Test'));
    const live = createCompletionWithFallback(client, { model: 'live-model' }, 'x', 'Test');
    setTimeout(() => controller.abort(new Error('deadline')), 5);
    await expect(shadow).rejects.toThrow('shadow aborted');
    await expect(live).resolves.toMatchObject({ model: 'live-model' });
    expect(shadowSignal!.aborted).toBe(true);
    const liveCall = create.mock.calls.find((call) => call[0].model === 'live-model')!;
    expect(liveCall).toHaveLength(1);
    const after = jest.fn().mockResolvedValue(completion());
    await createCompletionWithFallback(fakeClient(after), { model: 'later' }, 'x', 'Test');
    expect(after.mock.calls[0]).toHaveLength(1);
  });
});
