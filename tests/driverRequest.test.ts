import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import DriverRequest from '../src/models/DriverRequest.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Driver Request API', () => {

    let applicantUser: any;
    let applicantToken: string;
    const applicantEmail = 'driver.applicant@test.com';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test users
        await User.deleteMany({ email: applicantEmail });

        // Create test user
        applicantUser = await User.create({
            email: applicantEmail,
            name: 'Juan Driver',
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });

        applicantToken = tokenService.generateAccessToken(applicantUser);
    }, 15000);

    beforeEach(async () => {
        // Targeted clean up for our specific test applicant only
        await DriverRequest.deleteMany({ driverUserId: applicantUser._id });
    });

    afterAll(async () => {
        await DriverRequest.deleteMany({ driverUserId: applicantUser._id });
        await User.deleteMany({ email: applicantEmail });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should create a pending driver request when a user POSTs to /api/driver-requests', async () => {
        const response = await request(app)
            .post('/api/driver-requests')
            .set('Authorization', `Bearer ${applicantToken}`)
            .send({});

        expect(response.status).toBe(201);
        expect(response.body.data.status).toBe('pending');

        const savedRequest = await DriverRequest.findOne({
            driverUserId: applicantUser._id
        });

        expect(savedRequest).not.toBeNull();
        expect(savedRequest?.status).toBe('pending');
    });

});
