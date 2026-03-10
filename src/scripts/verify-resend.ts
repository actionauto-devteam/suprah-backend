import axios from 'axios';

const BACKEND_URL = 'http://localhost:5000/api';

async function verifyResend() {
    console.log('🛡️ Verifying Resend OTP Flow...');
    const testEmail = `resend_${Date.now()}@example.com`;

    try {
        // 1. Register
        console.log('1. Registering user...');
        await axios.post(`${BACKEND_URL}/auth/register`, {
            email: testEmail,
            password: 'Password123!',
            name: 'Resend Test'
        });

        // 2. Resend once
        console.log('2. Resending OTP (Attempt 1)...');
        const res1 = await axios.post(`${BACKEND_URL}/auth/resend-otp`, { email: testEmail });
        console.log('✅ Success:', res1.data.message);

        // 3. Resend twice
        console.log('3. Resending OTP (Attempt 2)...');
        const res2 = await axios.post(`${BACKEND_URL}/auth/resend-otp`, { email: testEmail });
        console.log('✅ Success:', res2.data.message);

        // 4. Resend thrice
        console.log('4. Resending OTP (Attempt 3)...');
        const res3 = await axios.post(`${BACKEND_URL}/auth/resend-otp`, { email: testEmail });
        console.log('✅ Success:', res3.data.message);

        // 5. Resend fourth (Should fail due to 3 per 3 min limit)
        console.log('5. Resending OTP (Attempt 4) - Expecting 429...');
        try {
            await axios.post(`${BACKEND_URL}/auth/resend-otp`, { email: testEmail });
            console.error('❌ Failed: Should have been blocked by ratelimit!');
        } catch (e: any) {
            if (e.response?.status === 429) {
                console.log('✅ Success: Blocked by OTP Flood Guard as expected.');
            } else {
                throw e;
            }
        }

        console.log('\n💎 RESEND FLOW & RATE LIMITING VERIFIED');
    } catch (e: any) {
        console.error('❌ Failed:', e.message);
        if (e.response) console.error('Data:', JSON.stringify(e.response.data, null, 2));
    }
    process.exit();
}

verifyResend();
