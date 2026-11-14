const send = jest.fn();
const mainById = jest.fn(), mainLinked = jest.fn(), crmById = jest.fn(), crmLinked = jest.fn();
jest.mock('web-push', () => ({ __esModule: true, default: { setVapidDetails: jest.fn(), sendNotification: send } }));
jest.mock('../../src/config', () => ({ __esModule: true, default: { push: {} } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mainById, findOne: mainLinked } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: crmById, findOne: crmLinked } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser: jest.fn(), emitToCrmUser: jest.fn() }));
jest.mock('../../src/utils/pushPayload', () => ({ normalizePushPayload: (payload: unknown) => ({ payload }) }));
import push from '../../src/services/unifiedPush.service';

let sequence = 0;
const payload = () => ({ title: 'Task assigned', body: 'Review', tag: `reliability-${sequence}` });
const query = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
beforeEach(() => {
  jest.clearAllMocks(); sequence++;
  const subscription = { endpoint: `https://push.example.test/device-${sequence}`, keys: {} };
  const main = { _id: 'main', email: 'person@example.test', organizationId: 'org', pushSubscriptions: [subscription] };
  const crm = { ...main, _id: 'crm' };
  mainById.mockImplementation(id => query(id === 'main' ? main : null));
  mainLinked.mockReturnValue(query(main));
  crmById.mockReturnValue(query(crm));
  crmLinked.mockReturnValue(query(crm));
  send.mockResolvedValue({ statusCode: 201 });
});

it('suppresses a linked identity duplicate only after successful push acceptance', async () => {
  await push.sendToUser('main', payload());
  await push.sendToUser('crm', payload());
  expect(send).toHaveBeenCalledTimes(1);
});

it('a failed first identity never suppresses the linked identity retry', async () => {
  send.mockRejectedValueOnce({ statusCode: 503, message: 'Temporary outage' });
  expect((await push.sendToUser('main', payload())).failed).toBe(1);
  expect((await push.sendToUser('crm', payload())).sent).toBe(1);
  expect(send).toHaveBeenCalledTimes(2);
});

it.each([true, false])('concurrent identities wait for the first send and handle accepted=%s', async accepted => {
  let finish!: () => void;
  send.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = () => accepted ? resolve({ statusCode: 201 }) : reject({ statusCode: 503 });
  }));
  const first = push.sendToUser('main', payload());
  await new Promise(resolve => setImmediate(resolve));
  const second = push.sendToUser('crm', payload());
  await new Promise(resolve => setImmediate(resolve));
  expect(send).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second]);
  expect(send).toHaveBeenCalledTimes(accepted ? 1 : 2);
});

it('does not suppress successive notifications to the same identity', async () => {
  await push.sendToUser('main', payload());
  await push.sendToUser('main', payload());
  expect(send).toHaveBeenCalledTimes(2);
});
