const remove = jest.fn(), removeRead = jest.fn(), emit = jest.fn();
jest.mock('../../src/models/Notification.model', () => ({
  __esModule: true, default: { findOneAndDelete: remove, deleteMany: removeRead },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/unifiedPush.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser: emit, emitToCrmUser: jest.fn() }));
import notifications from '../../src/services/notification.service';

beforeEach(() => jest.resetAllMocks());

it('broadcasts a successful deletion only to the recipient account', async () => {
  remove.mockResolvedValue({ _id: 'notice' });
  await notifications.deleteNotification('notice', 'org', 'recipient');
  expect(remove).toHaveBeenCalledWith({ _id: 'notice', userId: 'recipient' });
  expect(emit).toHaveBeenCalledWith('recipient', 'notification:deleted', { notificationId: 'notice' });
});

it('does not broadcast an unauthorized or missing deletion', async () => {
  remove.mockResolvedValue(null);
  await expect(notifications.deleteNotification('notice', 'org', 'other-user')).rejects.toMatchObject({ statusCode: 404 });
  expect(emit).not.toHaveBeenCalled();
});

it('broadcasts read-only bulk deletion after the database succeeds', async () => {
  removeRead.mockResolvedValue({ deletedCount: 3 });
  await notifications.deleteAllRead('recipient', 'org');
  expect(removeRead).toHaveBeenCalledWith({ userId: 'recipient', isRead: true });
  expect(emit).toHaveBeenCalledWith('recipient', 'notification:deleteAllRead', { deletedCount: 3 });
});

it('does not broadcast a failed deletion', async () => {
  removeRead.mockRejectedValue(new Error('database unavailable'));
  await expect(notifications.deleteAllRead('recipient', 'org')).rejects.toThrow('database unavailable');
  expect(emit).not.toHaveBeenCalled();
});
