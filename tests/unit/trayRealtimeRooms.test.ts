const mockUserFindById = jest.fn();
const mockCrmFindOne = jest.fn();
const mockCrmFindById = jest.fn();
const mockJwtVerify = jest.fn();

jest.mock('jsonwebtoken', () => ({ __esModule: true, default: { verify: mockJwtVerify } }));
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { env: 'test', jwt: { accessSecret: 'access-secret', crmJwtSecret: 'crm-secret' } },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/models/PresenceEvent.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/CrmUser.model', () => ({
  __esModule: true,
  default: { findOne: mockCrmFindOne, findById: mockCrmFindById },
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  addCrmOnlineUser: jest.fn(),
  removeCrmOnlineUser: jest.fn(),
  emitToShiftBoard: jest.fn(),
  emitPresenceUpdate: jest.fn(),
}));

import { setupSocket } from '../../src/socket';

const MAIN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CRM_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const leanChain = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

const connect = async (auth: Record<string, unknown>) => {
  let middleware: (socket: any, next: (err?: Error) => void) => Promise<void>;
  let onConnection: (socket: any) => void;
  const io: any = {
    use: (fn: typeof middleware) => { middleware = fn; },
    on: (event: string, fn: typeof onConnection) => { if (event === 'connection') onConnection = fn; },
    to: () => ({ emit: jest.fn() }),
    sockets: { adapter: { rooms: new Map() } },
  };
  setupSocket(io);
  const socket: any = { handshake: { auth, headers: {} }, join: jest.fn(), leave: jest.fn(), on: jest.fn(), emit: jest.fn() };
  await new Promise<void>((resolve, reject) => {
    middleware(socket, (err) => (err ? reject(err) : resolve()));
  });
  onConnection!(socket);
  return socket;
};

const joinedRooms = (socket: any): string[] => socket.join.mock.calls.map((call: unknown[]) => call[0] as string);

describe('tray socket rooms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindById.mockImplementation(() =>
      leanChain({ _id: MAIN_ID, role: 'employee', organizationId: 'org1', isActive: true, email: 'Pat@Example.com' }),
    );
    mockCrmFindOne.mockImplementation(() => leanChain({ _id: CRM_ID }));
    mockCrmFindById.mockImplementation(() => leanChain({ role: 'employee', organizationId: 'org1' }));
    mockJwtVerify.mockImplementation((_token: string, secret: string) => {
      if (secret === 'access-secret') return { sub: MAIN_ID };
      throw new Error('not a main token');
    });
  });

  it('a tray signed in with a main-site token also receives events sent to its linked CRM identity', async () => {
    const socket = await connect({ token: 'main-jwt', clientType: 'tray' });
    const rooms = joinedRooms(socket);
    expect(rooms).toEqual(expect.arrayContaining([`user:${MAIN_ID}`, `crm-user:${CRM_ID}`, 'tray-clients', `user:${CRM_ID}`]));
  });

  it('a website socket with the same main-site token does not join the CRM user room, so notification events stay separate', async () => {
    const socket = await connect({ token: 'main-jwt' });
    const rooms = joinedRooms(socket);
    expect(rooms).toContain(`user:${MAIN_ID}`);
    expect(rooms).toContain(`crm-user:${CRM_ID}`);
    expect(rooms).not.toContain(`user:${CRM_ID}`);
    expect(rooms).not.toContain('tray-clients');
  });

  it('a tray with no linked CRM identity gets no extra room', async () => {
    mockCrmFindOne.mockImplementation(() => leanChain(null));
    const socket = await connect({ token: 'main-jwt', clientType: 'tray' });
    const rooms = joinedRooms(socket);
    expect(rooms.filter((room) => room.startsWith('user:'))).toEqual([`user:${MAIN_ID}`]);
  });

  it('a tray signed in with a CRM token joins its CRM user room exactly once', async () => {
    mockJwtVerify.mockImplementation((_token: string, secret: string) => {
      if (secret === 'crm-secret') return { id: CRM_ID, type: 'crm' };
      throw new Error('not a main token');
    });
    const socket = await connect({ token: 'crm-jwt', clientType: 'tray' });
    const rooms = joinedRooms(socket);
    expect(rooms.filter((room) => room === `user:${CRM_ID}`)).toHaveLength(1);
    expect(rooms).toContain('tray-clients');
  });

  it('a website socket signed in with a CRM token is unchanged', async () => {
    mockJwtVerify.mockImplementation((_token: string, secret: string) => {
      if (secret === 'crm-secret') return { id: CRM_ID, type: 'crm' };
      throw new Error('not a main token');
    });
    const socket = await connect({ token: 'crm-jwt' });
    const rooms = joinedRooms(socket);
    expect(rooms).toContain(`user:${CRM_ID}`);
    expect(rooms).not.toContain('tray-clients');
  });
});
