"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const server_1 = __importDefault(require("../src/server"));
const Vehicle_model_1 = __importDefault(require("../src/models/Vehicle.model"));
const User_model_1 = __importDefault(require("../src/models/User.model"));
const token_service_1 = __importDefault(require("../src/services/token.service"));
describe('My Work Routes', () => {
    let user;
    let otherUser;
    let accessToken;
    let vehicleId;
    beforeAll(async () => {
        user = await User_model_1.default.create({
            email: 'tech@example.com',
            password: 'password123',
            name: 'Technician',
            role: 'user'
        });
        otherUser = await User_model_1.default.create({
            email: 'other@example.com',
            password: 'password123',
            name: 'Other Tech',
            role: 'user'
        });
        const tokens = await token_service_1.default.generateAuthTokens(user);
        accessToken = tokens.access.token;
    });
    beforeEach(async () => {
        // Seed a vehicle assigned to user
        const vehicle = await Vehicle_model_1.default.create({
            vin: 'VIN_MYWORK', year: 2023, make: 'Ford', modelName: 'F150',
            status: 'In Recon', currentStep: 'Inspection',
            assignedTo: user._id
        });
        vehicleId = vehicle._id.toString();
        // Vehicle assigned to someone else
        await Vehicle_model_1.default.create({
            vin: 'VIN_OTHER', year: 2023, make: 'Chevy', modelName: 'Silverado',
            status: 'In Recon', currentStep: 'Inspection',
            assignedTo: otherUser._id
        });
    });
    afterAll(async () => {
        await User_model_1.default.deleteMany({});
        await Vehicle_model_1.default.deleteMany({});
    });
    afterEach(async () => {
        await Vehicle_model_1.default.deleteMany({});
    });
    test('GET /api/my-work should return only assigned vehicles', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .get('/api/my-work')
            .set('Authorization', `Bearer ${accessToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].vin).toBe('VIN_MYWORK');
    });
    test('PATCH /api/my-work/:id/step should update step', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .patch(`/api/my-work/${vehicleId}/step`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({
            nextStep: 'Mechanical'
        });
        expect(res.status).toBe(200);
        expect(res.body.data.currentStep).toBe('Mechanical');
        // Verify in DB
        const updated = await Vehicle_model_1.default.findById(vehicleId);
        expect(updated?.currentStep).toBe('Mechanical');
    });
    test('POST /api/my-work/:id/notes should add a note', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .post(`/api/my-work/${vehicleId}/notes`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ text: 'Inspection passed' });
        expect(res.status).toBe(200);
        expect(res.body.data.notes).toHaveLength(1);
        expect(res.body.data.notes[0].text).toBe('Inspection passed');
    });
});
