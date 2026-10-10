const mockTaskCreate = jest.fn();
const mockNotifyUsers = jest.fn();
const mockNotifyOrgAdmins = jest.fn();

jest.mock('../../src/models/AiAgentTask.model', () => ({
  __esModule: true,
  default: { create: mockTaskCreate },
}));

jest.mock('../../src/utils/safeNotification', () => ({
  __esModule: true,
  notifyUsers: mockNotifyUsers,
  notifyOrgAdmins: mockNotifyOrgAdmins,
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { createAiAgentTaskAndNotify } from '../../src/utils/aiAgentTask';

describe('createAiAgentTaskAndNotify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTaskCreate.mockResolvedValue({});
    mockNotifyUsers.mockResolvedValue({ successful: 1, total: 1 });
    mockNotifyOrgAdmins.mockResolvedValue({ successful: 1, total: 1 });
  });

  it('creates exactly one task and notifies the assigned rep when the lead has one', async () => {
    const result = await createAiAgentTaskAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-1',
      channel: 'sms',
      question: 'confirm vehicle availability',
      agentName: 'Alex',
      customerName: 'Jordan Lee',
      assignedTo: 'user-1',
    });

    expect(mockTaskCreate).toHaveBeenCalledTimes(1);
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        leadId: 'lead-1',
        channel: 'sms',
        question: 'confirm vehicle availability',
        assigneeIds: ['user-1'],
        status: 'pending',
      }),
    );
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).toHaveBeenCalledWith(
      ['user-1'],
      'org-1',
      'ai_agent_handoff_needed',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ leadId: 'lead-1' }),
    );
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
    expect(result).toEqual({ notified: true });
  });

  it('falls back to notifying org admins when the lead has no assignee', async () => {
    const result = await createAiAgentTaskAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-2',
      channel: 'webchat',
      question: undefined,
      agentName: 'Alex',
      customerName: 'A customer',
      assignedTo: null,
    });

    expect(mockTaskCreate).toHaveBeenCalledWith(expect.objectContaining({ assigneeIds: [] }));
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ notified: true });
  });

  it('still notifies even if the task record fails to save', async () => {
    mockTaskCreate.mockRejectedValueOnce(new Error('db down'));

    const result = await createAiAgentTaskAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-3',
      channel: 'sms',
      question: 'reason',
      agentName: 'Alex',
      customerName: 'A customer',
      assignedTo: null,
    });

    expect(mockNotifyOrgAdmins).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ notified: true });
  });

  it('reports notified:false when notifying the assigned rep fails for every recipient', async () => {
    mockNotifyUsers.mockResolvedValueOnce({ successful: 0, total: 1 });

    const result = await createAiAgentTaskAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-4',
      channel: 'sms',
      question: 'reason',
      agentName: 'Alex',
      customerName: 'A customer',
      assignedTo: 'user-1',
    });

    expect(result).toEqual({ notified: false });
  });

  it('reports notified:false when notifyUsers rejects/returns null', async () => {
    mockNotifyUsers.mockResolvedValueOnce(null);

    const result = await createAiAgentTaskAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-5',
      channel: 'sms',
      question: 'reason',
      agentName: 'Alex',
      customerName: 'A customer',
      assignedTo: 'user-1',
    });

    expect(result).toEqual({ notified: false });
  });

  it('reports notified:false when the org-admin fallback notifies nobody', async () => {
    mockNotifyOrgAdmins.mockResolvedValueOnce({ successful: 0, total: 0 });

    const result = await createAiAgentTaskAndNotify({
      organizationId: 'org-1',
      leadId: 'lead-6',
      channel: 'webchat',
      question: undefined,
      agentName: 'Alex',
      customerName: 'A customer',
      assignedTo: null,
    });

    expect(result).toEqual({ notified: false });
  });
});
