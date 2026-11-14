const send = jest.fn();
const findCrmUsers = jest.fn();
const updateCrm = jest.fn();
const emitMain = jest.fn(), emitCrm = jest.fn();
jest.mock('web-push', () => ({ __esModule: true, default: { setVapidDetails: jest.fn(), sendNotification: send } }));
jest.mock('../../src/config', () => ({ __esModule: true, default: { push: {} } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { find: findCrmUsers, updateOne: updateCrm } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/utils/pushPayload', () => ({ normalizePushPayload: (payload: unknown) => ({ payload }) }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser: emitMain, emitToCrmUser: emitCrm }));
import CrmPushService from '../../src/services/crmPush.service';
import UnifiedPushService from '../../src/services/unifiedPush.service';

beforeEach(() => {
  jest.clearAllMocks();
  findCrmUsers.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'person',
    pushSubscriptions: [{ endpoint: 'https://push.example.test/device', keys: {}, failureCount: 99, createdAt: new Date() }] }] }) });
  updateCrm.mockResolvedValue({ modifiedCount: 1 });
});
it.each([429, 500, 503, undefined, 401])('keeps the endpoint after repeated transient/configuration failures (%s)', async statusCode => {
  send.mockRejectedValue({ statusCode, message: 'Temporary push error' });
  const result = await CrmPushService.sendToUsers(['person'], { title: 'Task assigned' });
  expect(result.failed).toBe(1);
  expect(updateCrm.mock.calls.some(([, update]) => update.$pull)).toBe(false);
  expect(updateCrm.mock.calls.some(([, update]) => update.$inc)).toBe(true);
});
it.each([404, 410])('prunes endpoints which the provider confirms are gone (%s)', async statusCode => {
  send.mockRejectedValue({ statusCode });
  const result = await CrmPushService.sendToUsers(['person'], { title: 'Task assigned' });
  expect(result.pruned).toBe(1);
  expect(updateCrm.mock.calls.some(([, update]) => update.$pull)).toBe(true);
});
it('uses connected clients to dismiss read notifications without silent Web Push', async () => {
  await UnifiedPushService.dismiss('person', 'task');
  expect(send).not.toHaveBeenCalled();
  expect(emitMain).toHaveBeenCalledWith('person', 'notification:dismiss', { tag: 'task' });
  expect(emitCrm).toHaveBeenCalledWith('person', 'notification:dismiss', { tag: 'task' });
});
