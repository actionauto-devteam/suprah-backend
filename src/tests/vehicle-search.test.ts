import mongoose from 'mongoose';
import connectDB, { disconnectDB } from '../config/db';
import Vehicle from '../models/Vehicle.model';
import { Request, Response } from 'express';

const describeIfAtlas = process.env.MONGODB_URI?.includes('mongodb+srv') ? describe : describe.skip;

describeIfAtlas('Vehicle Atlas Search Integration', () => {
    const TEST_ORG_ID = 'STITCH_SEARCH_TEST_123';
    
    beforeAll(async () => {
        await connectDB();
        
        await Vehicle.deleteMany({ organizationId: TEST_ORG_ID });

        await Vehicle.create([
            {
                vin: 'TESTVIN001',
                year: 2024,
                make: 'Acura',
                modelName: 'Integra',
                status: 'Ready for Sale',
                organizationId: TEST_ORG_ID,
                stockNumber: 'S001',
                price: 35000,
                isDeleted: false
            },
            {
                vin: 'TESTVIN002',
                year: 2022,
                make: 'Acura',
                modelName: 'MDX',
                status: 'Ready for Sale',
                organizationId: TEST_ORG_ID,
                stockNumber: 'S002',
                price: 45000,
                isDeleted: false
            },
            {
                vin: 'TESTVIN003',
                year: 2024,
                make: 'Honda',
                modelName: 'Civic',
                status: 'In Recon',
                organizationId: TEST_ORG_ID,
                stockNumber: 'S003',
                price: 25000,
                isDeleted: false
            }
        ]);

        console.log('Waiting 10 seconds for Atlas Search indexer to process test data...');
        await new Promise(resolve => setTimeout(resolve, 10000));
    }, 45000);

    afterAll(async () => {
        await Vehicle.deleteMany({ organizationId: TEST_ORG_ID });
        await disconnectDB();
    });

    test('should find 2024 Acura using multi-term search', async () => {
        const search = '2024 Acura';
        const searchString = search.toString();
        
        const pipeline = [
            {
                $search: {
                    index: 'Vehicle',
                    compound: {
                        must: [
                            { equals: { value: TEST_ORG_ID, path: 'organizationId' } }
                        ],
                        should: [
                            {
                                text: {
                                    query: searchString,
                                    path: ['make', 'modelName', 'vin', 'stockNumber'],
                                    fuzzy: { maxEdits: 1 }
                                }
                            },
                            {
                                equals: {
                                    value: 2024,
                                    path: 'year'
                                }
                            }
                        ]
                    }
                }
            },
            { $match: { organizationId: TEST_ORG_ID, isDeleted: false } }
        ];

        const results = await Vehicle.aggregate(pipeline);
        console.log('Search Results:', results.length);
        
        expect(results.length).toBeGreaterThan(0);
        const vinList = results.map(r => r.vin);
        expect(vinList).toContain('TESTVIN001');
    });

    test('should respect filters (Price) alongside search', async () => {
        const search = 'Acura';
        
        const pipeline = [
            {
                $search: {
                    index: 'Vehicle',
                    compound: {
                        must: [{ equals: { value: TEST_ORG_ID, path: 'organizationId' } }],
                        should: [{ text: { query: search, path: ['make', 'modelName'] } }]
                    }
                }
            },
            { $match: { organizationId: TEST_ORG_ID, price: { $gte: 40000 } } }
        ];

        const results = await Vehicle.aggregate(pipeline);
        console.log('Price Filter Results:', results.length);
        
        expect(results.length).toBe(1);
        expect(results[0].modelName).toBe('MDX');
    });

    test('should find vehicles by VIN partial match (keyword search)', async () => {
        const search = 'TESTVIN003';
        
        const pipeline = [
            {
                $search: {
                    index: 'Vehicle',
                    compound: {
                        must: [{ equals: { value: TEST_ORG_ID, path: 'organizationId' } }],
                        should: [{ text: { query: search, path: ['vin'] } }]
                    }
                }
            },
            { $match: { organizationId: TEST_ORG_ID } }
        ];

        const results = await Vehicle.aggregate(pipeline);
        console.log('VIN Search Results:', results.length);
        
        expect(results.length).toBe(1);
        expect(results[0].make).toBe('Honda');
    });
});
