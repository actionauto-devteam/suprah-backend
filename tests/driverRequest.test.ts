import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import DriverRequest from '../src/models/DriverRequest.model';
import { clerkClient } from '@clerk/clerk-sdk-node';

// ─── I-cast ang clerkClient bilang mock para magamit ang .mockResolvedValueOnce ───
// Kailangan ito para ma-override natin ang verifyToken sa bawat test
const mockedClerk = clerkClient as jest.Mocked<any>;

// ─── DESCRIBE ─────────────────────────────────────────────────────────────────
// Ito ang "grupo" ng tests. Lahat ng related na tests ay nasa loob nito.
describe('Driver Request API', () => {

    // ─── MGA VARIABLES ────────────────────────────────────────────────────────
    // Dito ilalagay ang data na gagamitin ng lahat ng tests sa loob ng describe

    // Ito ang magiging "driver applicant" — regular user na mag-aapply
    let applicantUser: any;

    // Ito ang Clerk ID na ibibigay sa mock — dapat same sa clerkId ng user sa DB
    const APPLICANT_CLERK_ID = 'test_driver_applicant_clerk_id';

    // ─── BEFORE ALL ───────────────────────────────────────────────────────────
    // Isang beses lang tatakbo bago ang lahat ng tests sa loob ng describe
    // Dito ginagawa ang "setup" na kailangan ng lahat ng tests
    beforeAll(async () => {

        // Gumawa ng test user sa DB na magiging "driver applicant"
        // Pansinin: ang clerkId ay dapat same sa APPLICANT_CLERK_ID na gamit sa mock
        applicantUser = await User.create({
            clerkId: APPLICANT_CLERK_ID,   // <-- ito ang "key" na nag-uugnay ng mock at DB user
            email:   'driver.applicant@test.com',
            name:    'Juan Driver',
            role:    'user',               // regular user pa — hindi pa driver
        });

    }, 15000); // 15 second timeout para sa DB connection

    // ─── BEFORE EACH ──────────────────────────────────────────────────────────
    // Tatakbo bago ang BAWAT isang test
    // Purpose: linisin ang DriverRequest table para hindi mag-interfere ang data
    beforeEach(async () => {
        await DriverRequest.deleteMany({});
        // NOTE: hindi natin dini-delete ang Users — once create lang sa beforeAll
    });

    // ─── AFTER ALL ────────────────────────────────────────────────────────────
    // Tatakbo isang beses pagkatapos ng LAHAT ng tests
    // Purpose: linisin ang DB para walang natirang test data
    afterAll(async () => {
        await DriverRequest.deleteMany({});
        await User.deleteMany({ clerkId: APPLICANT_CLERK_ID });
    });

    // =========================================================================
    // TEST #1 — Ang pinaka-basic: mag-create ng driver request
    // =========================================================================
    it('should create a pending driver request when a user POSTs to /api/driver-requests', async () => {

        // STEP 1: I-mock kung sino ang "naka-login"
        //
        // Ang auth middleware natin ay tumatawag ng clerkClient.verifyToken(token)
        // Sa real app, ito ay nagre-return ng decoded JWT.
        // Sa test, pinapanggap lang natin na ang token ay valid at ang naka-login
        // ay ang user na may clerkId === APPLICANT_CLERK_ID.
        //
        // Ang "sub" ay ang Clerk user ID — ito ang hahanapin ng auth middleware sa DB
        // Ang "sid" ay ang session ID — required ng Clerk pero hindi importante dito
        //
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: APPLICANT_CLERK_ID,  // <-- dapat tugma sa clerkId ng user sa DB
            sid: 'sess_test_123',
        });

        // STEP 2: Mag-send ng HTTP POST request gamit ang supertest
        //
        // Ito ay katulad ng mag-fetch() sa frontend, pero para sa testing.
        // Ang 'Bearer fake_token' ay kahit anong string — hindi naman genuine token,
        // kasi na-mock na natin ang verifyToken para palaging mag-accept.
        //
        const response = await request(app)
            .post('/api/driver-requests')               // <-- yung route na ginawa natin
            .set('Authorization', 'Bearer fake_token')  // <-- auth header
            .send({});                                  // <-- walang body, hindi na kailangan

        // STEP 3: I-check ang response
        //
        // expect() ay mag-fa-fail ang test kung hindi tugma ang value
        //

        // Dapat 201 Created ang HTTP status
        expect(response.status).toBe(201);

        // Dapat may "data" sa response body na may status na "pending"
        expect(response.body.data.status).toBe('pending');

        // STEP 4 (Bonus): I-verify sa DB mismo na talaga ngang nalikha ang record
        //
        // Hindi lang tayo nagtitiwala sa response — tinitingnan din natin ang DB
        //
        const savedRequest = await DriverRequest.findOne({
            driverUserId: applicantUser._id
        });

        // Dapat may nahanap na record sa DB
        expect(savedRequest).not.toBeNull();

        // Dapat 'pending' ang status sa DB
        expect(savedRequest?.status).toBe('pending');

    });

});
