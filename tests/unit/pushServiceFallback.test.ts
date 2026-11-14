const sendToUser = jest.fn(), dismiss = jest.fn();
jest.mock('../../src/config', () => ({ __esModule: true, default: { redis: { enabled: false } } }));
jest.mock('../../src/jobs/push.queue', () => ({ pushQueue: null }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/crmPush.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser, dismiss } }));
import PushService from '../../src/services/push.service';
beforeEach(() => { jest.clearAllMocks(); sendToUser.mockResolvedValue({ sent: 1, failed: 0, pruned: 0 }); });
it('delivers directly instead of silently discarding notifications when Redis is disabled', async () => {
  const payload = { title: 'Load assigned', data: { url: '/driver/loads/one' } };
  const result = await PushService.send('person', payload);
  expect(sendToUser).toHaveBeenCalledWith('person', payload);
  expect(result).toMatchObject({ success: true, sent: 1 });
});
it('reports a direct transport failure honestly', async () => {
  sendToUser.mockResolvedValue({ sent: 0, failed: 1, pruned: 0 });
  expect(await PushService.send('person', { title: 'Task assigned' })).toMatchObject({ success: false, failed: 1 });
});
it('broadcasts directly and counts accepted sends without Redis', async () => {
  const result = await PushService.broadcast(['one', 'two'], { title: 'Reminder' });
  expect(sendToUser).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ success: true, sentCount: 2 });
});
it('legacy dismissal payloads use sockets instead of a background push', async () => {
  await PushService.send('person', { isSyncAction: true, tag: 'read' });
  expect(sendToUser).not.toHaveBeenCalled();
  expect(dismiss).toHaveBeenCalledWith('person', 'read');
});
