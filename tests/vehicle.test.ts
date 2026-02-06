import request from 'supertest';
import app from '../src/server';
import Vehicle from '../src/models/Vehicle.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

describe('Vehicle API Endpoints', () => {
    let authToken: string;
    let testVehicleId: string;
    let userId: mongoose.Types.ObjectId;

    const mockedClerk = clerkClient as jest.Mocked<any>;

    beforeAll(async () => {
        // Create a test user ID
        userId = new mongoose.Types.ObjectId();
        authToken = 'mock_token';
    });

    beforeEach(async () => {
        // SAFETY: Only clear if we are explicitly on a test DB name
        const dbName = mongoose.connection.name;
        if (dbName && dbName.includes('test')) {
            await Vehicle.deleteMany({});
        } else {
            console.warn(`[SAFETY] Skipping deleteMany because database name "${dbName}" does not look like a test DB.`);
        }

        // Create a test vehicle
        const vehicle = await Vehicle.create({
            vin: 'TEST123456789',
            year: 2023,
            make: 'Toyota',
            modelName: 'Camry',
            trim: 'LE',
            color: 'Blue',
            stockNumber: 'STOCK001',
            price: 25000,
            marketPrice: 27000,
            mileage: 15000,
            transmission: 'Automatic',
            fuelType: 'Gasoline',
            location: 'Main Lot',
            status: 'Ready for Sale',
            currentStep: 'Ready'
        });

        testVehicleId = vehicle._id.toString();

        // Setup standard mock for all requests
        mockedClerk.verifyToken.mockResolvedValue({
            sub: 'test_clerk_user_id',
            sid: 'sess_123',
            org_id: 'test_org_id',
            org_role: 'org:admin'
        });
    });

    afterAll(async () => {
        await Vehicle.deleteMany({});
    });

    describe('GET /api/vehicles', () => {
        it('should return vehicles with default filter (Ready for Sale)', async () => {
            const res = await request(app)
                .get('/api/vehicles')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.data.vehicles).toBeInstanceOf(Array);
            expect(res.body.data.pagination).toBeDefined();
            expect(res.body.data.pagination.page).toBe(1);
        });

        it('should filter vehicles by make', async () => {
            const res = await request(app)
                .get('/api/vehicles?make=Toyota')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data.vehicles).toBeInstanceOf(Array);
            expect(res.body.data.vehicles.length).toBeGreaterThan(0);
            expect(res.body.data.vehicles[0].make).toBe('Toyota');
        });

        it('should sort vehicles by price descending', async () => {
            await Vehicle.create({
                vin: 'TEST987654321',
                year: 2024,
                make: 'Honda',
                modelName: 'Accord',
                price: 30000,
                status: 'Ready for Sale'
            });

            const res = await request(app)
                .get('/api/vehicles?sortBy=price&sortOrder=desc')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            const vehicles = res.body.data.vehicles;
            expect(vehicles[0].price).toBeGreaterThanOrEqual(vehicles[1]?.price || 0);
        });

        it('should paginate results', async () => {
            const res = await request(app)
                .get('/api/vehicles?page=1&limit=5')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data.pagination.limit).toBe(5);
            expect(res.body.data.pagination.page).toBe(1);
        });

        it('should filter by year', async () => {
            const res = await request(app)
                .get('/api/vehicles?year=2023')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data.vehicles[0].year).toBe(2023);
        });

        it('should filter by price range', async () => {
            const res = await request(app)
                .get('/api/vehicles?minPrice=20000&maxPrice=30000')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            const vehicles = res.body.data.vehicles;
            vehicles.forEach((v: any) => {
                expect(v.price).toBeGreaterThanOrEqual(20000);
                expect(v.price).toBeLessThanOrEqual(30000);
            });
        });
    });

    describe('GET /api/vehicles/filters', () => {
        it('should return available filter options', async () => {
            const res = await request(app)
                .get('/api/vehicles/filters')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toHaveProperty('makes');
            expect(res.body.data).toHaveProperty('models');
            expect(res.body.data).toHaveProperty('years');
            expect(res.body.data).toHaveProperty('locations');
            expect(res.body.data.makes).toContain('Toyota');
        });
    });

    describe('GET /api/vehicles/stats', () => {
        it('should return inventory statistics', async () => {
            const res = await request(app)
                .get('/api/vehicles/stats')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toHaveProperty('total');
            expect(res.body.data).toHaveProperty('byStatus');
            expect(res.body.data).toHaveProperty('averagePrice');
            expect(res.body.data).toHaveProperty('averageDaysOnLot');
            expect(res.body.data).toHaveProperty('totalValue');
            expect(res.body.data.total).toBeGreaterThan(0);
        });
    });

    describe('GET /api/vehicles/dashboard/graphs', () => {
        it('should return graph data for dashboard', async () => {
            const res = await request(app)
                .get('/api/vehicles/dashboard/graphs')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toHaveProperty('salesTrend');
            expect(res.body.data).toHaveProperty('inventoryByMake');
            expect(res.body.data).toHaveProperty('priceDistribution');
            expect(res.body.data).toHaveProperty('daysOnLotAverage');
            expect(res.body.data.salesTrend).toBeInstanceOf(Array);
        });
    });

    describe('GET /api/vehicles/:id', () => {
        it('should return a single vehicle by ID', async () => {
            const res = await request(app)
                .get(`/api/vehicles/${testVehicleId}`)
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data.vin).toBe('TEST123456789');
            expect(res.body.data.make).toBe('Toyota');
        });

        it('should return 404 for non-existent vehicle', async () => {
            const fakeId = new mongoose.Types.ObjectId();
            await request(app)
                .get(`/api/vehicles/${fakeId}`)
                .set('Authorization', `Bearer ${authToken}`)
                .expect(404);
        });
    });

    describe('PATCH /api/vehicles/:id/status', () => {
        it('should update vehicle status', async () => {
            const res = await request(app)
                .patch(`/api/vehicles/${testVehicleId}/status`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ status: 'Sold', currentStep: 'Ready' })
                .expect(200);

            expect(res.body.data.status).toBe('Sold');
        });

        it('should set manualStatusLock to true when status is updated', async () => {
            const res = await request(app)
                .patch(`/api/vehicles/${testVehicleId}/status`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ status: 'Sold' })
                .expect(200);

            const vehicle = await Vehicle.findById(testVehicleId);
            expect(vehicle?.manualStatusLock).toBe(true);
        });

        it('should return 400 if status is missing', async () => {
            await request(app)
                .patch(`/api/vehicles/${testVehicleId}/status`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({})
                .expect(400);
        });
    });

    describe('GET /api/vehicles/export', () => {
        it('should export vehicles as CSV', async () => {
            const res = await request(app)
                .get('/api/vehicles/export')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toContain('attachment');
            expect(res.text).toContain('VIN,Year,Make,Model');
            expect(res.text).toContain('TEST123456789');
        });
    });

    describe('GET /api/vehicles/dashboard', () => {
        it('should return dashboard summary data', async () => {
            const res = await request(app)
                .get('/api/vehicles/dashboard')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toHaveProperty('recentVehicles');
            expect(res.body.data).toHaveProperty('statusBreakdown');
            expect(res.body.data).toHaveProperty('alerts');
            expect(res.body.data.recentVehicles).toBeInstanceOf(Array);
        });
    });

    describe('GET /api/vehicles/search/autocomplete', () => {
        it('should return autocomplete suggestions', async () => {
            const res = await request(app)
                .get('/api/vehicles/search/autocomplete?q=Toy')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toBeInstanceOf(Array);
            expect(res.body.data.length).toBeGreaterThan(0);
            expect(res.body.data[0]).toHaveProperty('type');
            expect(res.body.data[0]).toHaveProperty('value');
        });

        it('should return empty array for short query', async () => {
            const res = await request(app)
                .get('/api/vehicles/search/autocomplete?q=T')
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toEqual([]);
        });
    });

    describe('GET /api/vehicles/:id/availability', () => {
        it('should check vehicle availability', async () => {
            const res = await request(app)
                .get(`/api/vehicles/${testVehicleId}/availability`)
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            expect(res.body.data).toHaveProperty('available');
            expect(res.body.data).toHaveProperty('status');
            expect(res.body.data).toHaveProperty('location');
            expect(res.body.data.available).toBe(true);
            expect(res.body.data.status).toBe('Ready for Sale');
        });
    });

    describe('POST /api/vehicles/:id/reserve', () => {
        it('should reserve a vehicle', async () => {
            const res = await request(app)
                .post(`/api/vehicles/${testVehicleId}/reserve`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ customerName: 'John Doe', duration: 48 })
                .expect(200);

            expect(res.body.data).toHaveProperty('reservedUntil');
            expect(res.body.message).toContain('reserved successfully');
        });

        it('should return 400 if customer name is missing', async () => {
            await request(app)
                .post(`/api/vehicles/${testVehicleId}/reserve`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ duration: 24 })
                .expect(400);
        });

        it('should return 400 if vehicle is not available', async () => {
            await Vehicle.findByIdAndUpdate(testVehicleId, { status: 'Sold' });

            await request(app)
                .post(`/api/vehicles/${testVehicleId}/reserve`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ customerName: 'John Doe' })
                .expect(400);
        });
    });

    describe('POST /api/vehicles/:id/notes', () => {
        it('should add a note to vehicle', async () => {
            const res = await request(app)
                .post(`/api/vehicles/${testVehicleId}/notes`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ text: 'Test note' })
                .expect(200);

            expect(res.body.message).toContain('Note added successfully');
        });
    });

    describe('PUT /api/vehicles/:id', () => {
        it('should update a vehicle', async () => {
            const res = await request(app)
                .put(`/api/vehicles/${testVehicleId}`)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ price: 26000, mileage: 16000 })
                .expect(200);

            expect(res.body.data.price).toBe(26000);
            expect(res.body.data.mileage).toBe(16000);
        });
    });

    describe('DELETE /api/vehicles/:id', () => {
        it('should delete a vehicle', async () => {
            await request(app)
                .delete(`/api/vehicles/${testVehicleId}`)
                .set('Authorization', `Bearer ${authToken}`)
                .expect(200);

            const vehicle = await Vehicle.findById(testVehicleId);
            expect(vehicle).toBeNull();
        });
    });
});
