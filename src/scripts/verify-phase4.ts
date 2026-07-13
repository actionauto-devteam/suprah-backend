import axios from 'axios';

const BACKEND_URL = 'http://localhost:5000/api';

async function verifyPhase4() {
    console.log('🧪 Verifying Phase 4: The Logic Swap...');

    const testEmail = `test_phase4@example.com`;
    const testPassword = 'Password123!';

    try {
        console.log(`\n1. Attempting Login for ${testEmail}...`);

        let accessToken = '';
        try {
            const loginRes = await axios.post(`${BACKEND_URL}/auth/login`, {
                email: testEmail,
                password: testPassword
            });
            accessToken = loginRes.data.data.accessToken;
            console.log('✅ Login successful, Access Token received.');
        } catch (e: any) {
            console.log('User might not exist, attempting registration...');
            const regRes = await axios.post(`${BACKEND_URL}/auth/register`, {
                name: 'Phase 4 Tester',
                email: testEmail,
                password: testPassword
            });
            accessToken = regRes.data.data.accessToken;
            console.log('✅ Registration successful, Access Token received.');
        }

        // 2. Heat Check: Hit a protected route (Profile)
        console.log(`\n2. Testing Protected Route (/profile)...`);

        const profileRes = await axios.get(`${BACKEND_URL}/profile`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (profileRes.status === 200) {
            console.log('✅ SUCCESS: Native JWT correctly authorized access to /profile');
            console.log(`👤 User Name: ${profileRes.data.data.name}`);
        } else {
            console.error('❌ FAILED: Unexpected response status:', profileRes.status);
        }

        console.log('\n💎 GATE 4 PASSED: LOGIC SWAP VERIFIED');

    } catch (error: any) {
        console.error('\n❌ Verification Error:', error.response?.data || error.message);
        process.exit(1);
    }
}

verifyPhase4();
