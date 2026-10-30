const findUsers = jest.fn();
const updateUser = jest.fn();
const send = jest.fn();
jest.mock('web-push', () => ({ __esModule: true, default: { setVapidDetails: jest.fn(), sendNotification: send } }));
jest.mock('../../src/config', () => ({ __esModule: true, default: { push: { vapidSubject: 'mailto:test@example.com', vapidPublicKey: 'test', vapidPrivateKey: 'test' } } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { find: findUsers, updateOne: updateUser } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
import { CrmPushService } from '../../src/services/crmPush.service';
const user = { _id: 'self', pushSubscriptions: [
  { endpoint: 'https://push.example/pc', keys: { p256dh: 'pc-key', auth: 'pc-auth' }, deviceHint: 'desktop-pwa', appSource: 'main' },
  { endpoint: 'https://push.example/phone', keys: { p256dh: 'phone-key', auth: 'phone-auth' }, deviceHint: 'android-pwa-mobile', appSource: 'main' },
  { endpoint: 'https://push.example/chat', keys: { p256dh: 'chat-key', auth: 'chat-auth' }, appSource: 'supraspace' },
] };
beforeEach(() => {
  jest.resetAllMocks();
  findUsers.mockReturnValue({ select: () => ({ lean: async () => [user] }) });
  send.mockResolvedValue(undefined); updateUser.mockResolvedValue({ modifiedCount: 1 });
});
it('sends to both PC and phone push services without requiring a live page/socket and records accepted devices', async () => {
  const onDelivered = jest.fn();
  const result = await CrmPushService.sendToUsers(['self'], { source: 'Suprah Meet', title: 'Room open', body: 'Join now', topic: 'meet-stage', data: { url: '/crm/suprah-meet/room/MEET-1234' } }, { ttlSeconds: 120, onDelivered });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(([sub]) => sub.endpoint)).toEqual(['https://push.example/pc', 'https://push.example/phone']);
  expect(send.mock.calls.every(([, , options]) => options.TTL === 120 && options.urgency === 'high' && options.topic.length === 32)).toBe(true);
  expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({ data: { url: '/crm/suprah-meet/room/MEET-1234' } });
  expect(onDelivered.mock.calls.map(([endpoint]) => endpoint)).toEqual(['https://push.example/pc', 'https://push.example/phone']);
  expect(result.sent).toBe(2);
});
it('excludes devices that already accepted the meeting event', async () => {
  await CrmPushService.sendToUsers(['self'], { title: 'Retry' }, { excludeEndpoints: ['https://push.example/pc'] });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].endpoint).toBe('https://push.example/phone');
});
it('keeps other CRM notification delivery defaults unchanged', async () => {
  await CrmPushService.sendToUsers(['self'], { title: 'Other CRM alert' });
  expect(send.mock.calls.every(([, , options]) => options.TTL === 86400)).toBe(true);
});
