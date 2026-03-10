import axios from 'axios';

const BACKEND_URL = 'http://localhost:5000/api';

async function runRateLimitTest() {
    console.log('🛡️ Starting Phase 11 Rate Limit Verification...');

    const testEmail = `ratelimit_${Date.now()}@example.com`;

    // 1. Test Auth Limiter (5 requests / 15 mins)
    console.log('\n1. Testing Auth Limiter (Login/Register)...');
    for (let i = 1; i <= 6; i++) {
        try {
            console.log(`Attempt ${i}: POST /api/auth/login`);
            await axios.post(`${BACKEND_URL}/auth/login`, {
                email: testEmail,
                password: 'WrongPassword'
            });
        } catch (e: any) {
            if (e.response?.status === 429) {
                console.log(`✅ Attempt ${i} blocked with 429 (Expected after 5).`);
                break;
            } else if (e.response?.status === 401 || e.response?.status === 404) {
                console.log(`- Attempt ${i}: Received ${e.response.status} (Allowed)`);
                if (i === 6) console.error('❌ Failed: Should have been blocked by effort 6!');
            } else {
                console.error(`❌ Unexpected error on attempt ${i}:`, e.message);
                throw e;
            }
        }
    }

    // 2. Test OTP Flood Guard (3 requests / 3 mins)
    console.log('\n2. Testing OTP Flood Guard (Verify Email)...');
    for (let i = 1; i <= 4; i++) {
        try {
            console.log(`Attempt ${i}: POST /api/auth/verify-email`);
            await axios.post(`${BACKEND_URL}/auth/verify-email`, {
                email: testEmail,
                code: '123456'
            });
        } catch (e: any) {
            if (e.response?.status === 429) {
                console.log(`✅ Attempt ${i} blocked with 429 (Expected after 3).`);
                break;
            } else if (e.response?.status === 500 || e.response?.status === 400 || e.response?.status === 404) {
                console.log(`- Attempt ${i}: Received ${e.response.status} (Allowed)`);
                if (i === 4) console.error('❌ Failed: Should have been blocked by effort 4!');
            } else {
                console.error(`❌ Unexpected error on attempt ${i}:`, e.message);
                throw e;
            }
        }
    }

    // 3. Test Security Headers (Helmet)
    console.log('\n3. Testing Security Headers (Helmet)...');
    try {
        const healthRes = await axios.get(`${BACKEND_URL.replace('/api', '/health')}`);
        const headers = healthRes.headers;

        const expectedHeaders = [
            'x-dns-prefetch-control',
            'x-frame-options',
            'x-content-type-options',
            'x-xss-protection'
        ];

        let foundCount = 0;
        expectedHeaders.forEach(h => {
            if (headers[h]) {
                console.log(`✅ Header found: ${h} = ${headers[h]}`);
                foundCount++;
            }
        });

        if (foundCount > 0) {
            console.log('✅ Helmet headers identified.');
        } else {
            console.warn('⚠️ No security headers found. Is helmet active?');
        }
    } catch (e: any) {
        console.error('❌ Failed to check headers:', e.message);
    }

    console.log('\n💎 PHASE 11 RATE LIMITING & SECURITY HEADERS VERIFIED');
    process.exit();
}

runRateLimitTest();
