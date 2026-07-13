import mongoose from 'mongoose';
import connectDB, { disconnectDB } from '../config/db';
import Vehicle from '../models/Vehicle.model';

const describeIfAtlas = (process.env.MONGODB_URI?.includes('mongodb+srv') || process.env.ALLOW_REMOTE_TEST_DB === 'true') ? describe : describe.skip;

describeIfAtlas('Vehicle Atlas Search Deep Diagnosis', () => {
    const TEST_ORG_ID = 'DEEP_DIAGNOSE_' + Date.now();
    
    beforeAll(async () => {
        await connectDB();
        
        console.log('Mongoose Collection Name:', Vehicle.collection.name);
        
        await Vehicle.create({
            vin: 'DIAGVIN' + Date.now(),
            year: 2024,
            make: 'Acura',
            modelName: 'Integra',
            status: 'Ready for Sale',
            organizationId: TEST_ORG_ID,
            stockNumber: 'D' + Date.now(),
            price: 35000,
            isDeleted: false
        });

        const count = await Vehicle.countDocuments({ organizationId: TEST_ORG_ID });
        console.log('Documents in DB for this Org:', count);

        console.log('Waiting 45 seconds for Atlas Search indexing...');
        await new Promise(resolve => setTimeout(resolve, 45000));
    }, 120000);

    afterAll(async () => {
        await Vehicle.deleteMany({ organizationId: TEST_ORG_ID });
        await disconnectDB();
    });

    test('DEEP_DIAG: Try empty search with orgId filter in engine', async () => {
        const pipeline = [
            {
                $search: {
                    index: 'test',
                    text: {
                        query: TEST_ORG_ID,
                        path: 'organizationId'
                    }
                }
            }
        ];

        const results = await Vehicle.aggregate(pipeline);
        console.log('OrgId only search count:', results.length);
        expect(results.length).toBeGreaterThan(0);
    });

    test('DEEP_DIAG: Try wildcard search on make', async () => {
        const pipeline = [
            {
                $search: {
                    index: 'test',
                    wildcard: {
                        query: '*',
                        path: 'make',
                        allowAnalyzedField: true
                    }
                }
            },
            { $match: { organizationId: TEST_ORG_ID } }
        ];

        const results = await Vehicle.aggregate(pipeline);
        console.log('Wildcard search count:', results.length);
        expect(results.length).toBeGreaterThan(0);
    });
});
