import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * UTILITY: Exchange authorization code for refresh token
 * 
 * Usage:
 * 1. Ensure CENTRAL_GOOGLE_CLIENT_ID and CENTRAL_GOOGLE_CLIENT_SECRET are in .env
 * 2. Update the CODE variable below with the code you got from the browser
 * 3. Run: npx ts-node scripts/get-token-from-code.ts
 */

const CODE = '4/0AfrIepC-H5IRkCHLIuNPlOCe2Fy6MVT4I_-XcWlRaY_15G530zzQTf1NB-65MTq49CaTBg';
const REDIRECT_URI = 'http://localhost:5000/api/google-calendar/callback';

async function exchange() {
    const clientId = process.env.CENTRAL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.CENTRAL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('❌ Google Client ID or Secret is missing from .env');
        process.exit(1);
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

    try {
        console.log('Exchanging code for tokens...');
        const { tokens } = await oauth2Client.getToken(CODE);

        console.log('\n✅ Tokens retrieved successfully:');
        console.log('--------------------------------------------------');
        console.log(`CENTRAL_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log(`CENTRAL_GMAIL_ACCESS_TOKEN=${tokens.access_token}`);
        console.log(`CENTRAL_GMAIL_EXPIRY_DATE=${tokens.expiry_date}`);
        console.log('--------------------------------------------------');

        if (!tokens.refresh_token) {
            console.warn('\n⚠️  WARNING: No refresh token returned. This usually means the app already has access.');
            console.warn('Try revoking access at https://myaccount.google.com/permissions and run again.');
        }
    } catch (err: any) {
        console.error('\n❌ Error retrieving tokens:', err.message);
    } finally {
        process.exit(0);
    }
}

exchange();
