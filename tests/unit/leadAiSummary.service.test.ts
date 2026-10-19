const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.LEAD_AI_SUMMARY_TIMEOUT_MS = '50';

import { generateLeadSummary } from '../../src/services/leadAiSummary.service';
import { TimelineItem } from '../../src/controllers/communication.controller';

function baseLead(overrides: any = {}) {
  return {
    _id: 'lead-1',
    firstName: 'Jordan',
    lastName: 'Lee',
    source: 'Website Chat',
    vehicle: { year: '2022', make: 'Toyota', model: 'Camry' },
    ...overrides,
  };
}

function timelineItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: 'sms:1',
    channel: 'sms',
    direction: 'inbound',
    title: 'Text received',
    body: 'Is this still available?',
    occurredAt: new Date('2026-09-28T10:00:00Z'),
    ...overrides,
  };
}

describe('generateLeadSummary', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns a templated fallback without calling Gemini when there is no timeline activity', async () => {
    const result = await generateLeadSummary(baseLead(), []);
    expect(result.summary).toContain('2022 Toyota Camry');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns the generated paragraph on a normal completion', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Jordan asked about a Camry and is waiting on a reply.' } }],
    });
    const result = await generateLeadSummary(baseLead(), [timelineItem()]);
    expect(result.summary).toBe('Jordan asked about a Camry and is waiting on a reply.');
    expect(result.error).toBeUndefined();
  });

  it('resolves to an error (not a rejection) when generation times out', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));
    const result = await generateLeadSummary(baseLead(), [timelineItem()]);
    expect(result.summary).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('resolves to an error when the model returns an empty completion', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
    const result = await generateLeadSummary(baseLead(), [timelineItem()]);
    expect(result.summary).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('resolves to a described error when the provider call throws', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('service down'), { status: 503 }));
    const result = await generateLeadSummary(baseLead(), [timelineItem()]);
    expect(result.summary).toBeNull();
    expect(result.error).toMatch(/unavailable/i);
  });
});

describe('generateLeadSummary — customers with multiple vehicle inquiries', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Jordan asked about the Camry.' } }] });
  });

  function promptsOfLastCall() {
    const messages = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0].messages;
    return {
      system: messages.find((m: any) => m.role === 'system').content as string,
      user: messages.find((m: any) => m.role === 'user').content as string,
    };
  }

  it('leaves out activity from the customer\'s other inquiries and tells the model to stay on this vehicle', async () => {
    await generateLeadSummary(baseLead(), [
      timelineItem({ id: 'sms:1', body: 'Is the Camry still there?', metadata: { inquiryScope: 'this_inquiry' } }),
      timelineItem({ id: 'sms:2', body: 'Can I see the 2025 Audi A5?', metadata: { inquiryScope: 'shared', relatedVehicleLabel: '2025 Audi A5' } }),
    ]);

    const { system, user } = promptsOfLastCall();
    expect(user).toContain('Is the Camry still there?');
    expect(user).not.toContain('Audi');
    expect(system).toContain('Summarize only this inquiry (the 2022 Toyota Camry) and do not mention any other vehicle');
  });

  it('returns the templated fallback when every activity item belongs to other inquiries', async () => {
    const result = await generateLeadSummary(baseLead(), [
      timelineItem({ body: 'Can I see the 2025 Audi A5?', metadata: { inquiryScope: 'shared' } }),
    ]);
    expect(result.summary).toContain('2022 Toyota Camry');
    expect(result.summary).not.toContain('Audi');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps single-inquiry summaries unchanged (no extra instruction, all activity included)', async () => {
    await generateLeadSummary(baseLead(), [timelineItem({ body: 'Is the Camry still there?' })]);

    const { system, user } = promptsOfLastCall();
    expect(user).toContain('Is the Camry still there?');
    expect(system).not.toMatch(/other vehicle/i);
  });
});
