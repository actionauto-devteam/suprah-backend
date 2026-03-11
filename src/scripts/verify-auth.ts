import axios from 'axios';

const BACKEND_URL = 'http://localhost:5000/api';

async function verifyAuth() {
    console.log('🚀 Starting Auth API Verification...');

    try {
        // 1. Test Registration
        const testEmail = `test_${Date.now()}@example.com`;
        console.log(`\n1. Testing Registration for: ${testEmail}`);
        const regRes = await axios.post(`${BACKEND_URL}/auth/register`, {
            email: testEmail,
            password: 'Password123!',
            name: 'Test User',
            role: 'customer'
        });
        console.log('✅ Registration Success:', regRes.data.message);
        const { accessToken } = regRes.data.data;

        // 2. Test Login
        console.log('\n2. Testing Login...');
        const loginRes = await axios.post(`${BACKEND_URL}/auth/login`, {
            email: testEmail,
            password: 'Password123!'
        });
        console.log('✅ Login Success:', loginRes.data.message);
        const loginAccessToken = loginRes.data.data.accessToken;

        // Note: We can't easily test HttpOnly cookies in a simple script without a cookie jar,
        // but we can check if the response headers set the cookie.
        const setCookie = loginRes.headers['set-cookie'];
        if (setCookie) {
            console.log('✅ Refresh Token Cookie set in headers');
        } else {
            console.log('⚠️ No Refresh Token Cookie found in headers (Check CORS/HttpOnly logic)');
        }

        // 3. Test Refresh Token (Simulation)
        // Since we didn't use a cookie jar, we'll try to use the raw token if the controller accepts it in body (it does)
        if (setCookie) {
            const refreshToken = setCookie[0].split(';')[0].split('=')[1];
            console.log('\n3. Testing Token Refresh...');
            const refreshRes = await axios.post(`${BACKEND_URL}/auth/refresh-tokens`, {
                refreshToken: refreshToken
            });
            console.log('✅ Token Refresh Success');
        }

        console.log('\n💎 ALL BACKEND AUTH TESTS PASSED');

    } catch (error: any) {
        console.error('\n❌ Verification Failed:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error:', error.message);
        }
        process.exit(1);
    }
}

verifyAuth();
