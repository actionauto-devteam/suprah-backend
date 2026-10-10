import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const mockMainFindById = jest.fn();
const mockCrmFindOne = jest.fn();
const mockCrmFindById = jest.fn();
const mockVerifyAccessToken = jest.fn();
const mockJwtVerify = jest.fn();

jest.mock('../../src/services/token.service', () => ({ __esModule: true, default: { verifyAccessToken: mockVerifyAccessToken } }));
jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: { verify: mockJwtVerify, decode: jest.fn(), JsonWebTokenError: class extends Error {}, TokenExpiredError: class extends Error {} },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockMainFindById } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findOne: mockCrmFindOne, findById: mockCrmFindById } }));
jest.mock('../../src/models/CrmLeadGroup.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/CallRoutingConfig.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/callRoutingConfig.service', () => ({ parseRoutingConfig: jest.fn(), validateRoutingGroups: jest.fn() }));
jest.mock('../../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550000' }));

import crmAuth from '../../src/middleware/crmAuth.middleware';
import { createGroup } from '../../src/controllers/crmLeadGroup.controller';
import { listRoutingConfigs } from '../../src/controllers/callRoutingConfig.controller';
import { updateAiAgentCoaching, deleteAiAgentCoaching } from '../../src/controllers/aiAgentCoaching.controller';

const orgId = new mongoose.Types.ObjectId().toString();
const userId = new mongoose.Types.ObjectId().toString();
const crmId = new mongoose.Types.ObjectId().toString();
const mainUser = (values: Record<string, unknown> = {}) => ({
  _id: userId, name: 'Employee', email: 'employee@example.com', role: 'employee', isActive: true, organizationId: orgId, ...values,
});
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.cookies = {}; next(); });
app.use(crmAuth());
app.get('/identity', (req, res) => res.json({ role: req.crmUser?.role, orgId: req.orgId, id: String(req.crmUser?._id) }));
app.post('/groups', createGroup);
app.get('/routing', listRoutingConfigs);
app.patch('/coaching/invalid', updateAiAgentCoaching);
app.delete('/coaching/invalid', deleteAiAgentCoaching);
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode || 500).json({ message: error.message });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyAccessToken.mockReturnValue({ sub: userId, orgId, role: 'admin' });
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser()) });
  mockCrmFindOne.mockResolvedValue(null);
});

test('an unlinked employee never inherits token/admin authority', async () => {
  const role = 'employee';
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ role })) });
  const response = await request(app).get('/identity').set('Authorization', 'Bearer main');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ role: 'employee', orgId, id: userId });
});

test.each(['customer', 'driver'])('an unlinked %s cannot inherit CRM staff privileges', async role => {
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ role })) });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).status).toBe(403);
});

test.each(['admin', 'super_admin'])('preserves trusted main-system %s access', async role => {
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ role })) });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).body.role).toBe('admin');
  expect((await request(app).post('/groups').set('Authorization', 'Bearer main').send({})).status).toBe(400);
});

test('preserves a database-backed organization admin', async () => {
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ organizationRole: 'admin' })) });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).body.role).toBe('admin');
});

test('uses a persisted organization manager without granting admin-only access', async () => {
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ organizationRole: 'manager' })) });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).body.role).toBe('manager');
  expect((await request(app).patch('/coaching/invalid').set('Authorization', 'Bearer main')).status).toBe(400);
  expect((await request(app).post('/groups').set('Authorization', 'Bearer main')).status).toBe(403);
});

test.each(['employee', 'manager', 'admin'])('uses the persisted linked CRM %s role', async role => {
  mockCrmFindOne.mockResolvedValue({ _id: crmId, role, organizationId: orgId, isActive: true });
  const response = await request(app).get('/identity').set('Authorization', 'Bearer main');
  expect(response.body).toEqual({ role, orgId, id: crmId });
  expect(mockCrmFindOne).toHaveBeenCalledWith({ email: 'employee@example.com', organizationId: orgId });
});

test.each([
  ['post', '/groups'], ['get', '/routing'], ['patch', '/coaching/invalid'], ['delete', '/coaching/invalid'],
])('blocks an unlinked employee from %s %s', async (method, path) => {
  const response = await (request(app) as any)[method](path).set('Authorization', 'Bearer main').send({});
  expect(response.status).toBe(403);
});

test('CRM manager can manage coaching but cannot administer groups', async () => {
  mockCrmFindOne.mockResolvedValue({ _id: crmId, role: 'manager', organizationId: orgId, isActive: true });
  expect((await request(app).patch('/coaching/invalid').set('Authorization', 'Bearer main')).status).toBe(400);
  expect((await request(app).post('/groups').set('Authorization', 'Bearer main')).status).toBe(403);
});

test('rejects a token whose organization no longer matches the persisted user', async () => {
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ organizationId: new mongoose.Types.ObjectId() })) });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).status).toBe(403);
});

test('rejects inactive main and linked CRM accounts', async () => {
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser({ isActive: false })) });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).status).toBe(401);
  mockMainFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(mainUser()) });
  mockCrmFindOne.mockResolvedValue({ isActive: false });
  expect((await request(app).get('/identity').set('Authorization', 'Bearer main')).status).toBe(403);
});

test.each(['employee', 'manager', 'admin'])('preserves direct CRM %s authentication', async role => {
  mockJwtVerify.mockReturnValue({ type: 'crm', id: crmId });
  mockCrmFindById.mockResolvedValue({ _id: crmId, role, isActive: true, organizationId: orgId });
  const req: any = { cookies: { crm_token: 'crm' }, headers: {}, query: {} };
  const next = jest.fn();
  await crmAuth()(req, {} as any, next);
  expect(next).toHaveBeenCalledWith();
  expect(req.crmUser.role).toBe(role);
});
