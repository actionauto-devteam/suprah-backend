import request from 'supertest';
import app from '../src/server';
import Shipment from '../src/models/Shipment.model';
import Quote from '../src/models/Quote.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Shipment API - Organization Isolation', () => {
    let orgA: any;
    let orgB: any;
    let userA: any;
    let userB: any;
    let tokenA: string;
    let tokenB: string;
    let quoteA_id: mongoose.Types.ObjectId;
    let quoteB_id: mongoose.Types.ObjectId;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        const testEmails = ['ship_userA@example.com', 'ship_userB@example.com'];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: { $in: ['ship-org-a', 'ship-org-b'] } });

        // Create Orgs
        orgA = await Organization.create({ name: 'Ship Org A', slug: 'ship-org-a', status: 'active' });
        orgB = await Organization.create({ name: 'Ship Org B', slug: 'ship-org-b', status: 'active' });

        // Create Users
        userA = await User.create({
            email: 'ship_userA@example.com',
            name: 'User A',
            role: 'admin',
            organizationId: orgA._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        userB = await User.create({
            email: 'ship_userB@example.com',
            name: 'User B',
            role: 'admin',
            organizationId: orgB._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        tokenA = tokenService.generateAccessToken(userA);
        tokenB = tokenService.generateAccessToken(userB);

        // Create dummy quotes for shipments
        const qA = await Quote.create({
            firstName: 'A', lastName: 'A', email: 'ship_q1@a.com', phone: '1', 
            organizationId: orgA._id.toString(),
            fromZip: '1', toZip: '2', fromAddress: '1', toAddress: '2', miles: 1, rate: 1,
            eta: { min: 1, max: 2 }, status: 'accepted', units: 1
        });
        quoteA_id = qA._id as mongoose.Types.ObjectId;

        const qB = await Quote.create({
            firstName: 'B', lastName: 'B', email: 'ship_q2@b.com', phone: '2', 
            organizationId: orgB._id.toString(),
            fromZip: '3', toZip: '4', fromAddress: '3', toAddress: '4', miles: 2, rate: 2,
            eta: { min: 2, max: 3 }, status: 'accepted', units: 1
        });
        quoteB_id = qB._id as mongoose.Types.ObjectId;
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: { $in: ['ship_userA@example.com', 'ship_userB@example.com'] } });
        await Organization.deleteMany({ _id: { $in: [orgA?._id, orgB?._id] } });
        await Quote.deleteMany({ _id: { $in: [quoteA_id, quoteB_id] } });
        await Shipment.deleteMany({ organizationId: { $in: [orgA?._id.toString(), orgB?._id.toString()] } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should only return shipments belonging to the user\'s organization', async () => {
        await Shipment.create({
            quoteId: quoteA_id,
            organizationId: orgA._id.toString(),
            origin: 'A',
            destination: 'B',
            requestedPickupDate: new Date()
        });

        await Shipment.create({
            quoteId: quoteB_id,
            organizationId: orgB._id.toString(),
            origin: 'C',
            destination: 'D',
            requestedPickupDate: new Date()
        });

        const res = await request(app)
            .get('/api/shipments')
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);

        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].organizationId).toBe(orgA._id.toString());
    });

    it('should assign correct organizationId when creating a new shipment', async () => {
        const freshQ = await Quote.create({
            firstName: 'New', lastName: 'Q', email: 'ship_new@q.com', phone: '5', 
            organizationId: orgA._id.toString(),
            fromZip: '1', toZip: '2', fromAddress: '1', toAddress: '2', miles: 1, rate: 1,
            eta: { min: 1, max: 2 }, status: 'accepted', units: 1
        });

        const newShipment = {
            quoteId: freshQ._id.toString(),
            origin: 'Origin City',
            destination: 'Dest City',
            requestedPickupDate: new Date()
        };

        const res = await request(app)
            .post('/api/shipments')
            .set('Authorization', `Bearer ${tokenA}`)
            .send(newShipment)
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA._id.toString());
    });
});
