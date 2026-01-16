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
describe('Dashboard Routes', () => {
    let user;
    let accessToken;
    beforeAll(async () => {
        // Generate a user and token
        user = await User_model_1.default.create({
            email: 'admin@example.com',
            password: 'password123',
            role: 'admin',
            name: 'Admin User'
        });
        // We need to bypass the actual login and just get a token, 
        // but auth middleware verifies it against the DB.
        // tokenService.generateAuthTokens returns { access: { token: ... }, ... }
        const tokens = await token_service_1.default.generateAuthTokens(user);
        accessToken = tokens.access.token;
    });
    afterAll(async () => {
        await User_model_1.default.deleteMany({});
        await Vehicle_model_1.default.deleteMany({});
    });
    test('GET /api/dashboard/metrics should return metrics', async () => {
        // Seed some vehicles
        await Vehicle_model_1.default.create({
            vin: 'VIN123', year: 2021, make: 'Toyota', modelName: 'Camry',
            status: 'In Recon', currentStep: 'Inspection'
        });
        await Vehicle_model_1.default.create({
            vin: 'VIN456', year: 2022, make: 'Honda', modelName: 'Civic',
            status: 'Ready for Sale', currentStep: 'Ready'
        });
        const res = await (0, supertest_1.default)(server_1.default)
            .get('/api/dashboard/metrics')
            .set('Authorization', `Bearer ${accessToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.inventoryOverview).toBeDefined();
        expect(res.body.data.inventoryOverview.totalActive).toBe(2);
        expect(res.body.data.inventoryOverview.inRecon).toBe(1);
        expect(res.body.data.reconStatus.Inspection).toBe(1);
    });
});
