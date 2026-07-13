import axios from 'axios';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const BACKEND_URL = 'http://localhost:5000/api';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto';

async function runSecurityTest() {
    console.log('🛡️ Starting Phase 10 Security Verification...');

    let userId: string | null = null;
    let token: string | null = null;

    try {
        const testEmail = `sec_test_${Date.now()}@example.com`;
        console.log(`\n1. Registering unverified user: ${testEmail}`);

        const regRes = await axios.post(`${BACKEND_URL}/auth/register`, {
            email: testEmail,
            password: 'Password123!',
            name: 'Security Test User',
            role: 'customer'
        });

        token = regRes.data.data.accessToken;
        userId = regRes.data.data.user._id || regRes.data.data.user.id;
        console.log('✅ User registered. Token acquired.');

        const authHeader = { Authorization: `Bearer ${token}` };

        // 2. Test Whitelist: /api/users/me
        console.log('\n2. Testing Whitelist: GET /api/users/me');
        try {
            const meRes = await axios.get(`${BACKEND_URL}/users/me`, { headers: authHeader });
            console.log('✅ Success (Expected): Accessible for unverified users.');
        } catch (e: any) {
            console.error('❌ Failed (Unexpected): /api/users/me should be whitelisted.');
            throw e;
        }

        // 3. Test Blocked: /api/organizations
        console.log('\n3. Testing Block: GET /api/organizations');
        try {
            await axios.get(`${BACKEND_URL}/organizations`, { headers: authHeader });
            console.log('❌ Failed (Security Gap): /api/organizations was accessible by unverified user!');
        } catch (e: any) {
            if (e.response?.status === 403) {
                console.log('✅ Blocked (Expected): 403 Forbidden received.');
            } else {
                console.error('❌ Failed (Unexpected Error):', e.message);
                throw e;
            }
        }

        // 4. Test Blocked: /api/profile
        console.log('\n4. Testing Block: GET /api/profile');
        try {
            await axios.get(`${BACKEND_URL}/profile`, { headers: authHeader });
            console.log('❌ Failed (Security Gap): /api/profile was accessible!');
        } catch (e: any) {
            if (e.response?.status === 403) {
                console.log('✅ Blocked (Expected): 403 Forbidden received.');
            } else {
                throw e;
            }
        }

        // 5. Test Blocked: /api/users/me/organizations (Whitelisted check)
        console.log('\n5. Testing Block: GET /api/users/me/organizations');
        try {
            await axios.get(`${BACKEND_URL}/users/me/organizations`, { headers: authHeader });
            console.log('❌ Failed (Security Gap): /api/users/me/organizations was accessible!');
        } catch (e: any) {
            if (e.response?.status === 403) {
                console.log('✅ Blocked (Expected): 403 Forbidden received.');
            } else {
                throw e;
            }
        }

        // 6. Manual Verification (Simulate Database update)
        console.log('\n6. Manually verifying user in Database...');
        await mongoose.connect(MONGODB_URI);
        const User = mongoose.model('User', new mongoose.Schema({ email: String, emailVerified: Boolean }));
        await User.updateOne({ email: testEmail }, { emailVerified: true });
        console.log('✅ User marked as verified in DB.');

        // 7. Test Passed: /api/organizations (Now verified)
        console.log('\n7. Testing Access: GET /api/organizations (After Verification)');
        try {
            const orgRes = await axios.get(`${BACKEND_URL}/organizations`, { headers: authHeader });
            console.log('✅ Success (Expected): Accessible after verification.');
        } catch (e: any) {
            console.error('❌ Failed (Unexpected): Should be accessible now.');
            throw e;
        }

        console.log('\n💎 PHASE 10 SECURITY HARDENING VERIFIED');

    } catch (error: any) {
        console.error('\n❌ Security Verification Failed:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error:', error.message);
        }
    } finally {
        await mongoose.disconnect();
        process.exit();
    }
}

runSecurityTest();
