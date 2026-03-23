import { google } from 'googleapis';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from root
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testCentralGmail() {
    console.log('\n--- 🧪 Central Gmail Diagnostic Tool ---');

    const clientId = process.env.CENTRAL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.CENTRAL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.CENTRAL_GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI;
    const refreshToken = process.env.CENTRAL_GMAIL_REFRESH_TOKEN;

    console.log('Configuration:');
    console.log(`- Client ID: ${clientId ? '✅ Found' : '❌ Missing'}`);
    console.log(`- Client Secret: ${clientSecret ? '✅ Found' : '❌ Missing'}`);
    console.log(`- Redirect URI: ${redirectUri || 'Not set (using default)'}`);
    console.log(`- Refresh Token: ${refreshToken ? (refreshToken.substring(0, 10) + '...') : '❌ Missing'}`);

    if (!refreshToken || !clientId || !clientSecret) {
        console.error('\n❌ Required environment variables are missing.');
        process.exit(1);
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    try {
        console.log('\nStep 1: Attempting to refresh access token...');
        const { credentials } = await oauth2Client.refreshAccessToken();
        console.log('✅ Token refresh successful!');
        console.log(`- New Access Token: ${credentials.access_token?.substring(0, 10)}...`);
        console.log(`- Expiry: ${new Date(credentials.expiry_date || 0).toLocaleString()}`);

        console.log('\nStep 2: Testing Gmail API access...');
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        console.log(`✅ Connected successfully as: ${profile.data.emailAddress}`);

        console.log('\nStep 3: Listing recent messages...');
        const response = await gmail.users.messages.list({ userId: 'me', maxResults: 5 });
        const messages = response.data.messages || [];
        console.log(`✅ Successfully retrieved ${messages.length} messages.`);

        console.log('\n✨ DIAGNOSTIC PASSED: Your configuration is valid.');

    } catch (error: any) {
        console.error('\n❌ DIAGNOSTIC FAILED!');
        console.error(`- Error Code: ${error.code || 'N/A'}`);
        console.error(`- Error Message: ${error.message}`);

        if (error.message.includes('invalid_grant')) {
            console.log('\n💡 RECOMMENDATION:');
            console.log('This error confirms the refresh token is dead.');
            console.log('1. Go to GCP Console and ensure project is "In Production".');
            console.log('2. Generate a FRESH refresh token (e.g., via OAuth2 Playground).');
            console.log('3. Update your .env with the new token.');
        } else if (error.message.includes('invalid_client')) {
            console.log('\n💡 RECOMMENDATION:');
            console.log('Check your Client ID and Client Secret. They likely do not match the project.');
        }
    } finally {
        process.exit(0);
    }
}

testCentralGmail().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
