import request from 'supertest';
import app from '../src/server';
import Vehicle from '../src/models/Vehicle.model';
import User from '../src/models/User.model';
import tokenService from '../src/services/token.service';

describe('My Work Routes', () => {
    let user: any;
    let otherUser: any;
    let accessToken: string;
    let vehicleId: string;

    beforeAll(async () => {
        user = await User.create({
            email: 'tech@example.com',
            password: 'password123',
            name: 'Technician',
            role: 'user'
        });

        otherUser = await User.create({
            email: 'other@example.com',
            password: 'password123',
            name: 'Other Tech',
            role: 'user'
        });

        const tokens = await tokenService.generateAuthTokens(user);
        accessToken = tokens.access.token;
    });

    beforeEach(async () => {
        // Seed a vehicle assigned to user
        const vehicle = await Vehicle.create({
            vin: 'VIN_MYWORK', year: 2023, make: 'Ford', modelName: 'F150',
            status: 'In Recon', currentStep: 'Inspection',
            assignedTo: user._id
        });
        vehicleId = vehicle._id.toString();

        // Vehicle assigned to someone else
        await Vehicle.create({
            vin: 'VIN_OTHER', year: 2023, make: 'Chevy', modelName: 'Silverado',
            status: 'In Recon', currentStep: 'Inspection',
            assignedTo: otherUser._id
        });
    });

    afterAll(async () => {
        await User.deleteMany({});
        await Vehicle.deleteMany({});
    });

    afterEach(async () => {
        await Vehicle.deleteMany({});
    });

    test('GET /api/my-work should return only assigned vehicles', async () => {
        const res = await request(app)
            .get('/api/my-work')
            .set('Authorization', `Bearer ${accessToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].vin).toBe('VIN_MYWORK');
    });

    test('PATCH /api/my-work/:id/step should update step', async () => {
        const res = await request(app)
            .patch(`/api/my-work/${vehicleId}/step`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({
                nextStep: 'Mechanical'
            });

        expect(res.status).toBe(200);
        expect(res.body.data.currentStep).toBe('Mechanical');

        // Verify in DB
        const updated = await Vehicle.findById(vehicleId);
        expect(updated?.currentStep).toBe('Mechanical');
    });

    test('POST /api/my-work/:id/notes should add a note', async () => {
        const res = await request(app)
            .post(`/api/my-work/${vehicleId}/notes`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ text: 'Inspection passed' });

        expect(res.status).toBe(200);
        expect(res.body.data.notes).toHaveLength(1);
        expect(res.body.data.notes[0].text).toBe('Inspection passed');
    });
});
