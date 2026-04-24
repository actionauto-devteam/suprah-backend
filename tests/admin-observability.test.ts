import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import tokenService from '../src/services/token.service';

describe('Admin Observability Security & Integrity', () => {
    let superAdminToken: string;
    let adminToken: string;
    let userToken: string;
    
    const superAdminEmail = 'super.admin@observability.com';
    const adminEmail = 'admin@observability.com';
    const userEmail = 'user@observability.com';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test users
        await User.deleteMany({ email: { $in: [superAdminEmail, adminEmail, userEmail] } });

        // Create Super Admin
        const superAdmin = await User.create({
            name: 'Super Admin',
            email: superAdminEmail,
            role: 'super_admin',
            emailVerified: true,
            onboardingCompleted: true
        });
        superAdminToken = tokenService.generateAccessToken(superAdmin);

        // Create Admin
        const admin = await User.create({
            name: 'Admin',
            email: adminEmail,
            role: 'admin',
            emailVerified: true,
            onboardingCompleted: true
        });
        adminToken = tokenService.generateAccessToken(admin);

        // Create Regular User
        const user = await User.create({
            name: 'User',
            email: userEmail,
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });
        userToken = tokenService.generateAccessToken(user);
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: { $in: [superAdminEmail, adminEmail, userEmail] } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });
    
    describe('RBAC Enforcement', () => {
        it('should block non-admin users from accessing system stats', async () => {
            const response = await request(app)
                .get('/api/admin/system/stats')
                .set('Authorization', `Bearer ${userToken}`);
            
            expect(response.status).toBe(403);
        });

        it('should block non-admin users from accessing system logs', async () => {
            const response = await request(app)
                .get('/api/admin/system/logs')
                .set('Authorization', `Bearer ${userToken}`);
            
            expect(response.status).toBe(403);
        });

        it('should allow super_admin to access system stats', async () => {
            const response = await request(app)
                .get('/api/admin/system/stats')
                .set('Authorization', `Bearer ${superAdminToken}`);
            
            expect(response.status).toBe(200);
            expect(response.body.message).toContain('retrieved successfully');
        });
    });

    describe('Path Traversal & Log Security', () => {
        it('should return system logs for super_admin', async () => {
            const response = await request(app)
                .get('/api/admin/system/logs?lines=10')
                .set('Authorization', `Bearer ${superAdminToken}`);
            
            // Note: In test environment, the log file might be empty, but it should return 200 and potentially an empty array
            expect(response.status).toBe(200);
            expect(Array.isArray(response.body.data)).toBe(true);
        });
    });

    describe('Input Sanitization', () => {
        it('should handle large line counts gracefully', async () => {
            const response = await request(app)
                .get('/api/admin/system/logs?lines=9999999')
                .set('Authorization', `Bearer ${superAdminToken}`);
            
            expect(response.status).toBe(200);
        });

        it('should handle invalid pagination gracefully for activity', async () => {
            const response = await request(app)
                .get('/api/activity/organization?limit=abc&page=-5')
                .set('Authorization', `Bearer ${superAdminToken}`);
            
            expect(response.status).toBe(200);
            expect(Array.isArray(response.body.data)).toBe(true);
        });
    });
});
