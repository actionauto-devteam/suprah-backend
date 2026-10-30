const findUser = jest.fn();
const push = jest.fn();
jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findOne: findUser } }));
jest.mock('../../src/services/crmPush.service', () => ({ CrmPushService: { sendToUsers: push } }));
import { testMeetingDevicePush } from '../../src/controllers/suprahMeetPush.controller';
const req = (body: object = {}) => ({ crmUser: { _id: 'self', organizationId: 'org' }, body });
const res = () => ({ json: jest.fn() });
const invoke = (request: any, response = res()) => (testMeetingDevicePush as any)(request, response, jest.fn());
beforeEach(() => {
  jest.resetAllMocks();
  findUser.mockReturnValue({ select: () => ({ lean: async () => ({ pushSubscriptions: [
    { endpoint: 'my-pc', appSource: 'main' }, { endpoint: 'my-phone', appSource: 'main' },
  ] }) }) });
  push.mockResolvedValue({ sent: 1, failed: 0 });
});
it('sends a real push only to the signed-in person current device, ignoring supplied target identities', async () => {
  const response = res();
  await invoke(req({ endpoint: 'my-pc', userId: 'somebody-else', organizationId: 'other-org' }), response);
  expect(findUser).toHaveBeenCalledWith({ _id: 'self', organizationId: 'org', isActive: true });
  expect(push).toHaveBeenCalledWith(['self'], expect.objectContaining({ source: 'Suprah Meet',
    data: { url: '/crm/suprah-meet', priority: 'high', soundProfile: 'attention' },
  }), { excludeEndpoints: ['my-phone'], ttlSeconds: 60, timeoutMs: 10_000 });
  expect(response.json.mock.calls[0][0].data).toEqual({ accepted: true });
});
it('rejects a device endpoint belonging to another account', async () => {
  await expect(invoke(req({ endpoint: 'someone-else-device' }))).rejects.toMatchObject({ statusCode: 409 });
  expect(push).not.toHaveBeenCalled();
});
it('does not claim success when the device push service accepted nothing', async () => {
  push.mockResolvedValue({ sent: 0, failed: 1 });
  await expect(invoke(req({ endpoint: 'my-phone' }))).rejects.toMatchObject({ statusCode: 502 });
});
it('requires authentication and an explicit current-device subscription', async () => {
  await expect(invoke({ body: { endpoint: 'my-pc' } })).rejects.toMatchObject({ statusCode: 401 });
  await expect(invoke(req())).rejects.toMatchObject({ statusCode: 400 });
  expect(push).not.toHaveBeenCalled();
});
