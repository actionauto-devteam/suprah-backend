const mockFind = jest.fn();

jest.mock('../../src/models/AiAgentCoachingRule.model', () => ({
  __esModule: true,
  default: {
    find: mockFind,
    updateMany: jest.fn().mockResolvedValue({}),
  },
}));

import { getRelevantAiCoaching } from '../../src/services/aiAgentCoaching.service';

const chain = (rules: any[]) => ({
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(rules),
});

describe('getRelevantAiCoaching', () => {
  beforeEach(() => {
    mockFind.mockReset();
  });

  it('fetches only active org coaching for the current channel', async () => {
    mockFind.mockReturnValue(chain([{ _id: 'rule-1', instruction: 'Ask for the preferred appointment time.' }]));

    const result = await getRelevantAiCoaching({ organizationId: 'org-1', channel: 'sms' });

    expect(mockFind).toHaveBeenCalledWith({
      organizationId: 'org-1',
      status: 'active',
      channel: { $in: ['all', 'sms'] },
    });
    expect(result).toEqual({
      notes: ['Ask for the preferred appointment time.'],
      ids: ['rule-1'],
      rules: [
        {
          id: 'rule-1',
          instruction: 'Ask for the preferred appointment time.',
          createdAt: undefined,
          updatedAt: undefined,
        },
      ],
    });
  });

  it('normalizes whitespace and caps the returned coaching payload', async () => {
    mockFind.mockReturnValue(
      chain([
        { _id: 'rule-1', instruction: '  Ask   one clear   question.  ' },
        { _id: 'rule-2', instruction: 'x'.repeat(2000) },
      ]),
    );

    const result = await getRelevantAiCoaching({ organizationId: 'org-1', channel: 'webchat' });

    expect(result.notes[0]).toBe('Ask one clear question.');
    expect(result.notes[1]).toHaveLength(320);
  });
});
