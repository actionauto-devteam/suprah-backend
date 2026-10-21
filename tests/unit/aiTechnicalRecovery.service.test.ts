const mockTaskFindOne = jest.fn();
jest.mock('../../src/models/AiAgentTask.model', () => ({ __esModule: true, default: { findOne: mockTaskFindOne, updateOne: jest.fn() } }));
jest.mock('../../src/services/communication.service', () => ({ isSmsOptedOut: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/services/email.service', () => ({ isEmailOptedOut: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/services/aiHumanAttention.service', () => ({ attentionOrgIds: (id: string) => [id] }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn() }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn() }));

import { recoverTechnicalPause, RECOVERY_BLOCKER_MESSAGES } from '../../src/services/aiTechnicalRecovery.service';

const ORG = '507f1f77bcf86cd799439011';
const TASK = '507f1f77bcf86cd799439012';

describe('recoverTechnicalPause authorization', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['employee', 'rep', '', undefined])('rejects role %p with 403 before reading any data', async role => {
    await expect(recoverTechnicalPause({ organizationId: ORG, taskId: TASK, user: { _id: 'u1', role }, acknowledged: true }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockTaskFindOne).not.toHaveBeenCalled();
  });

  it.each(['manager', 'admin', 'super_admin'])('lets %s through to the ownership check', async role => {
    mockTaskFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(recoverTechnicalPause({ organizationId: ORG, taskId: TASK, user: { _id: 'u1', role }, acknowledged: true }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockTaskFindOne).toHaveBeenCalledWith({ _id: TASK, organizationId: ORG });
  });

  it('returns 404 for a malformed task id without querying', async () => {
    await expect(recoverTechnicalPause({ organizationId: ORG, taskId: 'not-an-id', user: { _id: 'u1', role: 'admin' } }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockTaskFindOne).not.toHaveBeenCalled();
  });

  it('has a staff-readable message for every blocker', () => {
    for (const message of Object.values(RECOVERY_BLOCKER_MESSAGES)) expect(message.length).toBeGreaterThan(10);
  });
});
