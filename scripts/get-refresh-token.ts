import { google } from 'googleapis';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

/**
 * UTILITY: Generate a NEW refresh token
 * 
 * Usage:
 * 1. Ensure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are in .env
 * 2. Set GOOGLE_REDIRECT_URI to http://localhost:3000 (or whatever you configured in GCP)
 *    Note: You must ADD this URI to your GCP console Redirect URIs first!
 * 3. Run: npx ts-node scripts/get-refresh-token.ts
 */

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

async function getRefreshToken() {
    const clientId = process.env.CENTRAL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.CENTRAL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.CENTRAL_GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000';

    if (!clientId || !clientSecret) {
        console.error('❌ GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing from .env');
        process.exit(1);
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent', // Forces refresh token generation
    });

    console.log('\n--- 🔑 Refresh Token Generator ---');
    console.log('1. Open this URL in your browser:');
    console.log(authUrl);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question('\n2. Paste the code from the redirect URL here: ', async (code) => {
        rl.close();
        try {
            const { tokens } = await oauth2Client.getToken(code);
            console.log('\n✅ Success! Update your .env with these values:');
            console.log('--------------------------------------------------');
            console.log(`CENTRAL_GMAIL_ACCESS_TOKEN=${tokens.access_token}`);
            console.log(`CENTRAL_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
            console.log(`CENTRAL_GMAIL_EXPIRY_DATE=${tokens.expiry_date}`);
            console.log('--------------------------------------------------');

            if (!tokens.refresh_token) {
                console.warn('\n⚠️  WARNING: No refresh token returned. Try clearing app permissions in Google Account settings and run again.');
            }
        } catch (err: any) {
            console.error('\n❌ Error retrieving tokens:', err.message);
        } finally {
            process.exit(0);
        }
    });
}

getRefreshToken().catch(err => {
    console.error(err);
    process.exit(1);
});
