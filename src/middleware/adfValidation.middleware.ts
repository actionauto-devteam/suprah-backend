import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { decrypt } from '../utils/crypto';

export const validateAdfSignature = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = req.query.orgId || req.body.organizationId;
        const signature = req.headers['x-adf-signature'];

        if (!orgId) {
            return res.status(400).json({ message: 'MISSING_ORG_ID: organizationId is required for webhook ingestion' });
        }

        if (!signature) {
            return res.status(401).json({ message: 'MISSING_SIGNATURE: X-ADF-Signature header is required' });
        }

        const config = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true });
        if (!config || !config.webhookSecret) {
            return res.status(401).json({ message: 'UNAUTHORIZED: No webhook configuration found for this organization' });
        }

        const secret = decrypt(config.webhookSecret);

        let rawBody = (req as any).rawBody || req.body;

        if (rawBody && typeof rawBody !== 'string') {
            if (typeof rawBody === 'object') {
                rawBody = JSON.stringify(rawBody);
            } else {
                rawBody = null;
            }
        }

        if (!rawBody) {
            return res.status(400).json({ message: 'INVALID_BODY: No valid string content found in request body' });
        }

        const hmac = crypto.createHmac('sha256', secret);
        const expectedSignature = hmac.update(rawBody).digest('hex');

        const providedBuffer = Buffer.from(signature as string, 'hex');
        const expectedBuffer = Buffer.from(expectedSignature, 'hex');

        if (providedBuffer.length !== expectedBuffer.length) {
            console.warn(`[SECURITY] Invalid signature length for org: ${orgId}`);
            return res.status(401).json({ message: 'INVALID_SIGNATURE: Signature length mismatch' });
        }

        const isValid = crypto.timingSafeEqual(providedBuffer, expectedBuffer);

        if (!isValid) {
            console.warn(`[SECURITY] Invalid signature mismatch for org: ${orgId}`);
            return res.status(401).json({ message: 'INVALID_SIGNATURE: Signature mismatch' });
        }

        // Attach config to request for use in controller if needed
        (req as any).orgLeadConfig = config;

        next();
    } catch (error) {
        console.error('[SECURITY-ERROR] Webhook validation failed:', error);
        res.status(500).json({ message: 'Internal server error during security validation' });
    }
};
