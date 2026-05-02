import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import orgGmailService from '../services/orgGmail.service';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { encrypt, generateWebhookSecret } from '../utils/crypto';
import { IUser } from '../models/User.model';
import { v4 as uuidv4 } from 'uuid';
import googleCalendarService from '../services/googleCalendar.service';
import { google } from 'googleapis';
import { cacheService } from '../services/cache.service';

/**
 * Initiate Google OAuth flow for an organization
 * @route GET /api/org-lead/auth
 */
const initiateAuth = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;
    if (!orgId) throw new ApiError(400, 'Organization context missing');

    const authUrl = orgGmailService.getAuthUrl(orgId);
    res.json(new ApiResponse(200, { authUrl }, 'Authorization URL generated'));
});

/**
 * Handle Google OAuth callback for organization lead sync
 * @route GET /api/org-lead/callback
 */
const handleCallback = asyncHandler(async (req: Request, res: Response) => {
    const { code, state } = req.query; // state is the orgId
    const orgId = state as string;

    if (!code || !orgId) {
        return res.redirect(`${process.env.FRONTEND_URL}/crm/settings/integrations?error=missing_params`);
    }

    try {
        const tokens = await orgGmailService.getTokensFromCode(code as string);
        if (!tokens.access_token || !tokens.refresh_token) {
            throw new ApiError(400, 'Google did not return a refresh token. Please revoke access and try again.');
        }

        // Fetch the actual Google email address via userinfo API
        let gmailAddress = 'connected@workspace.com';
        try {
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET,
                process.env.GOOGLE_REDIRECT_URI
            );
            oauth2Client.setCredentials({ access_token: tokens.access_token });
            const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
            const userInfo = await oauth2.userinfo.get();
            gmailAddress = userInfo.data.email || gmailAddress;
            console.log(`[OrgOAuth] Authenticated as: ${gmailAddress}`);
        } catch (emailErr: any) {
            console.warn(`[OrgOAuth] Could not fetch email address: ${emailErr.message}`);
        }

        const updateData = {
            organizationId: orgId,
            connectedBy: (req.user as IUser)?._id,
            gmailAddress,
            accessToken: encrypt(tokens.access_token),
            refreshToken: encrypt(tokens.refresh_token),
            expiryDate: tokens.expiry_date,
            gmailConnected: true,
            calendarConnected: true,
            isActive: true,
            connectedAt: new Date(),
        };

        await OrgLeadConfig.findOneAndUpdate(
            { organizationId: orgId },
            { $set: updateData },
            { upsert: true, new: true }
        );

        // Invalidate Cache
        await cacheService.del(`config:org:${orgId}`);

        // --- NEW: Set up Calendar Webhook (non-critical) ---
        try {
            const channelId = uuidv4();
            await googleCalendarService.setupWebhook({ type: 'org', id: orgId }, channelId);
            console.log(`[OrgConfig] Calendar webhook set up for org ${orgId}`);
        } catch (webhookErr: any) {
            console.warn(`[OrgConfig] Webhook setup fail (ignorable): ${webhookErr.message}`);
        }

        res.redirect(`${process.env.FRONTEND_URL}/crm/settings/integrations?success=gmail_connected`);
    } catch (error: any) {
        console.error('[OrgOAuth] Callback Refused:', error);
        res.redirect(`${process.env.FRONTEND_URL}/crm/settings/integrations?error=${encodeURIComponent(error.message)}`);
    }
});

/**
 * Get organization lead configuration
 */
const getConfig = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;
    const cacheKey = `config:org:${orgId}`;
    let config = await cacheService.get(cacheKey);

    if (!config) {
        config = await OrgLeadConfig.findOne({ organizationId: orgId }).lean();
        if (config) {
            await cacheService.set(cacheKey, config, 3600); // 1hr
        }
    } else {
        console.log(`[Cache] Redis HIT for OrgConfig: ${orgId}`);
    }

    if (!config) {
        // Return empty config with default webhook secret if none exists
        return res.json(new ApiResponse(200, {
            gmailConnected: false,
            calendarConnected: false,
            isActive: false,
            leadSourceEmail: 'leads@dealerscloud.com',
            webhookUrl: `${process.env.BACKEND_URL}/api/leads/adf?orgId=${orgId}`
        }, 'No configuration found'));
    }

    res.json(new ApiResponse(200, {
        gmailAddress: config.gmailAddress,
        gmailConnected: config.gmailConnected,
        calendarConnected: config.calendarConnected,
        isActive: config.isActive,
        leadSourceEmail: config.leadSourceEmail,
        lastSyncAt: config.lastSyncAt,
        webhookUrl: `${process.env.BACKEND_URL}/api/leads/adf?orgId=${orgId}`,
        hasWebhookSecret: !!config.webhookSecret
    }, 'Configuration fetched'));
});

/**
 * Update configuration settings
 */
const updateConfig = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;
    const { leadSourceEmail, isActive } = req.body;

    const config = await OrgLeadConfig.findOneAndUpdate(
        { organizationId: orgId },
        { $set: { leadSourceEmail, isActive } },
        { new: true, upsert: true }
    );

    // Invalidate Cache
    await cacheService.del(`config:org:${orgId}`);

    res.json(new ApiResponse(200, config, 'Configuration updated'));
});

/**
 * Generate/Regenerate Webhook HMAC Secret
 */
const generateSecret = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;
    const newSecret = generateWebhookSecret();
    const encryptedSecret = encrypt(newSecret);

    await OrgLeadConfig.findOneAndUpdate(
        { organizationId: orgId },
        { $set: { webhookSecret: encryptedSecret } },
        { upsert: true }
    );

    // Invalidate Cache
    await cacheService.del(`config:org:${orgId}`);

    // Return the raw secret ONCE so the user can copy it
    res.json(new ApiResponse(200, { webhookSecret: newSecret }, 'Webhook secret generated. Copy it now, it will not be shown again.'));
});

/**
 * Trigger manual sync for both Gmail Leads and Google Calendar Events
 * @route POST /api/org-lead/sync
 */
const sync = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;
    const userId = (req.user as IUser)?._id?.toString();

    if (!orgId) throw new ApiError(400, 'Organization context missing');
    if (!userId) throw new ApiError(401, 'User session missing');

    console.log(`[ManualSync] Triggered by user ${userId} for org ${orgId}`);

    // Helper: detect Google "insufficient authentication scopes" errors
    const isInsufficientScopes = (err: any): boolean => {
        const msg: string = err?.message ?? err?.errors?.[0]?.message ?? '';
        return (
            msg.toLowerCase().includes('insufficient') ||
            msg.toLowerCase().includes('insufficientauthenticateduser') ||
            err?.status === 403 ||
            err?.code === 403
        );
    };

    // 1. Sync Gmail Leads
    let gmailResult;
    try {
        gmailResult = await orgGmailService.syncLeadsForOrg(orgId);
    } catch (err: any) {
        if (isInsufficientScopes(err)) {
            // Stale token — clear both Gmail & Calendar so the UI prompts reconnect
            await OrgLeadConfig.updateOne(
                { organizationId: orgId },
                { $set: { gmailConnected: false, calendarConnected: false } }
            );
            throw new ApiError(
                403,
                'Google account authorization is missing required permissions. Please disconnect and reconnect your Google account.'
            );
        }
        console.warn(`[ManualSync] Gmail sync failed: ${err.message}`);
        gmailResult = { processed: 0, errors: [] };
    }

    // 2. Sync Calendar Events (Uses OrgLeadConfig tokens via orgId)
    let calendarProcessed = 0;
    try {
        calendarProcessed = await googleCalendarService.syncAllEvents(orgId, userId);
    } catch (err: any) {
        // Only re-throw scope errors (403) — "not connected" (401/404) are expected and ignorable
        if (err instanceof ApiError && err.statusCode === 403) throw err;
        console.warn(`[ManualSync] Calendar sync failed (ignorable if not connected): ${err.message}`);
    }

    res.json(new ApiResponse(200, {
        leads: gmailResult,
        calendar: { processed: calendarProcessed }
    }, 'Manual synchronization complete'));
});

/**
 * Disconnect Google Integration (Gmail & Calendar) for organization
 * @route POST /api/org-lead/disconnect
 */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;
    if (!orgId) throw new ApiError(400, 'Organization context missing');

    await OrgLeadConfig.findOneAndUpdate(
        { organizationId: orgId },
        {
            $set: {
                gmailConnected: false,
                calendarConnected: false,
                accessToken: null,
                refreshToken: null,
                isActive: false,
                gmailAddress: null
            }
        }
    );

    // Invalidate Cache
    await cacheService.del(`config:org:${orgId}`);

    res.json(new ApiResponse(200, {}, 'Google integration disconnected successfully for the organization'));
});

export default {
    initiateAuth,
    handleCallback,
    getConfig,
    updateConfig,
    generateSecret,
    sync,
    disconnect,
};
