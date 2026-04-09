import request from 'supertest';
import app from '../src/server';
import Shipment from '../src/models/Shipment.model';
import Quote from '../src/models/Quote.model';
import User from '../src/models/User.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Shipment API - Organization Isolation', () => {
    const orgA = 'ship_org_A';
    const orgB = 'ship_org_B';
    const userA_id = 'ship_clerk_A';
    const userB_id = 'ship_clerk_B';
    let quoteA_id: mongoose.Types.ObjectId;
    let quoteB_id: mongoose.Types.ObjectId;

    beforeAll(async () => {
        // Create users in DB
        await User.create({ clerkId: userA_id, email: 'ship_userA@example.com', name: 'User A', role: 'user' });
        await User.create({ clerkId: userB_id, email: 'ship_userB@example.com', name: 'User B', role: 'user' });

        // Create dummy quotes for shipments
        const qA = await Quote.create({
            firstName: 'A', lastName: 'A', email: 'ship_q1@a.com', phone: '1', organizationId: orgA,
            fromZip: '1', toZip: '2', fromAddress: '1', toAddress: '2', miles: 1, rate: 1,
            eta: { min: 1, max: 2 }, status: 'accepted'
        });
        quoteA_id = qA._id as mongoose.Types.ObjectId;

        const qB = await Quote.create({
            firstName: 'B', lastName: 'B', email: 'ship_q2@b.com', phone: '2', organizationId: orgB,
            fromZip: '3', toZip: '4', fromAddress: '3', toAddress: '4', miles: 2, rate: 2,
            eta: { min: 2, max: 3 }, status: 'accepted'
        });
        quoteB_id = qB._id as mongoose.Types.ObjectId;
    }, 15000);

    afterAll(async () => {
        await User.deleteMany({ clerkId: { $in: [userA_id, userB_id] } });
        await Quote.deleteMany({ _id: { $in: [quoteA_id, quoteB_id] } });
        // Targeted shipment deletion
        await Shipment.deleteMany({ 
            $or: [
                { organizationId: { $in: [orgA, orgB] } },
                { quoteId: { $in: [quoteA_id, quoteB_id] } }
            ]
        });
    });

    it('should only return shipments belonging to the user\'s organization', async () => {
        await Shipment.create({
            quoteId: quoteA_id,
            organizationId: orgA,
            origin: 'A',
            destination: 'B',
            requestedPickupDate: new Date()
        });

        await Shipment.create({
            quoteId: quoteB_id,
            organizationId: orgB,
            origin: 'C',
            destination: 'D',
            requestedPickupDate: new Date()
        });

        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const res = await request(app)
            .get('/api/shipments')
            .set('Authorization', 'Bearer token_A')
            .expect(200);

        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].organizationId).toBe(orgA);
    });

    it('should assign correct organizationId when creating a new shipment', async () => {
        // Create a FRESH quote for this test to avoid "already converted" error
        const freshQ = await Quote.create({
            firstName: 'New', lastName: 'Q', email: 'ship_new@q.com', phone: '5', organizationId: orgA,
            fromZip: '1', toZip: '2', fromAddress: '1', toAddress: '2', miles: 1, rate: 1,
            eta: { min: 1, max: 2 }, status: 'accepted'
        });

        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const newShipment = {
            quoteId: freshQ._id.toString(),
            origin: 'Origin City',
            destination: 'Dest City',
            requestedPickupDate: new Date()
        };

        const res = await request(app)
            .post('/api/shipments')
            .set('Authorization', 'Bearer token_A')
            .send(newShipment)
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA);
    });
});
