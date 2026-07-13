import mongoose from 'mongoose';
import connectDB, { disconnectDB } from '../config/db';
import Vehicle from '../models/Vehicle.model';

const describeIfAtlas = (process.env.MONGODB_URI?.includes('mongodb+srv') || process.env.ALLOW_REMOTE_TEST_DB === 'true') ? describe : describe.skip;

describeIfAtlas('Vehicle Atlas Search Diagnosis', () => {
    const TEST_ORG_ID = 'DIAGNOSE_ORG_' + Date.now();
    
    beforeAll(async () => {
        await connectDB();
        await Vehicle.deleteMany({ organizationId: { $regex: 'DIAGNOSE_ORG' } });

        await Vehicle.create([
            {
                vin: 'DIAGVIN001',
                year: 2024,
                make: 'Acura',
                modelName: 'Integra',
                status: 'Ready for Sale',
                organizationId: TEST_ORG_ID,
                stockNumber: 'D001',
                price: 35000,
                isDeleted: false
            }
        ]);

        console.log('Test data created for Org:', TEST_ORG_ID);
        console.log('Waiting 30 seconds for Atlas Search indexing (Free Tier can be slow)...');
        await new Promise(resolve => setTimeout(resolve, 30000));
    }, 60000);

    afterAll(async () => {
        await disconnectDB();
    });

    test('DIAGNOSTIC: Search for Acura (Simple Should)', async () => {
        const pipeline = [
            {
                $search: {
                    index: 'test',
                    text: {
                        query: 'Acura',
                        path: ['make', 'modelName']
                    }
                }
            },
            { $match: { organizationId: TEST_ORG_ID } }
        ];

        console.log('Running Simple Should Search...');
        const results = await Vehicle.aggregate(pipeline);
        console.log('Simple Should Results Count:', results.length);
        
        if (results.length > 0) {
            console.log('First result score:', results[0].score);
        } else {
            console.log('WARNING: Simple search returned 0. This suggests indexing hasn\'t happened yet or field mapping is incorrect.');
        }

        expect(results.length).toBeGreaterThan(0);
    });

    test('DIAGNOSTIC: Search for Acura with Must OrgId', async () => {
        const pipeline = [
            {
                $search: {
                    index: 'test',
                    compound: {
                        must: [
                            { text: { query: TEST_ORG_ID, path: 'organizationId' } }
                        ],
                        should: [
                            { text: { query: 'Acura', path: 'make' } }
                        ]
                    }
                }
            }
        ];

        console.log('Running Compound Search with Must OrgId...');
        const results = await Vehicle.aggregate(pipeline);
        console.log('Compound Search Results Count:', results.length);

        expect(results.length).toBeGreaterThan(0);
    });
});
