import { Webhook } from 'svix';
import { Request, Response } from 'express';
import User from '../models/User.model';
import Organization from '../models/Organization.model';
import config from '../config';

// Clerk event types
type ClerkEvent = {
    data: any;
    object: string;
    type: string;
};

export const handleClerkWebhook = async (req: Request, res: Response) => {
    const secret = config.clerk.webhookSecret;

    if (!secret) {
        console.error('Missing CLERK_WEBHOOK_SECRET');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    // Get the headers
    const svix_id = req.headers['svix-id'] as string;
    const svix_timestamp = req.headers['svix-timestamp'] as string;
    const svix_signature = req.headers['svix-signature'] as string;

    // If there are no headers, error out
    if (!svix_id || !svix_timestamp || !svix_signature) {
        return res.status(400).json({ error: 'Error occured -- no svix headers' });
    }

    // Get the body
    // We use the raw body captured by express.json({ verify: ... }) in server.ts
    const payload = (req as any).rawBody;

    if (!payload) {
        return res.status(400).json({ error: 'No body provided or raw body missing' });
    }

    const wh = new Webhook(secret);

    let evt: ClerkEvent;

    try {
        evt = wh.verify(payload, {
            'svix-id': svix_id,
            'svix-timestamp': svix_timestamp,
            'svix-signature': svix_signature,
        }) as ClerkEvent;
    } catch (err: any) {
        console.error('Error verifying webhook:', err.message);
        return res.status(400).json({
            success: false,
            message: err.message,
        });
    }

    const { id } = evt.data;
    const eventType = evt.type;

    console.log('Running Webhook with event type', eventType);

    console.log(`Webhook with and ID of ${id} and type of ${eventType}`);

    try {
        if (eventType === 'user.created' || eventType === 'user.updated') {
            const email = evt.data.email_addresses[0]?.email_address;
            const firstName = evt.data.first_name || '';
            const lastName = evt.data.last_name || '';
            const name = `${firstName} ${lastName}`.trim() || 'No Name';
            const picture = evt.data.image_url || evt.data.profile_image_url;

            // Upsert user
            await User.findOneAndUpdate(
                { clerkId: id },
                {
                    clerkId: id,
                    email,
                    name,
                    avatar: picture,
                    emailVerified: true, // Assuming Clerk handles this
                    // Do not overwrite role if it exists elsewhere, or set default
                },
                { upsert: true, new: true }
            );
        } else if (eventType === 'user.deleted') {
            await User.findOneAndDelete({ clerkId: id });
        } else if (eventType === 'organization.created' || eventType === 'organization.updated') {
            const { name, slug, image_url, public_metadata } = evt.data;
            await Organization.findOneAndUpdate(
                { clerkId: id },
                {
                    clerkId: id,
                    name,
                    slug,
                    logoUrl: image_url,
                    metadata: public_metadata,
                },
                { upsert: true, new: true }
            );
        } else if (eventType === 'organization.deleted') {
            await Organization.findOneAndDelete({ clerkId: id });
            // Optionally: Update all users in this org to have organizationId: null
            await User.updateMany({ organizationId: id }, { $set: { organizationId: null, organizationRole: null } });
        } else if (eventType === 'organizationMembership.created' || eventType === 'organizationMembership.updated') {
            const orgId = evt.data.organization.id;
            const userId = evt.data.public_user_data.user_id;
            const role = evt.data.role;

            await User.findOneAndUpdate(
                { clerkId: userId },
                {
                    organizationId: orgId,
                    organizationRole: role,
                }
            );
        } else if (eventType === 'organizationMembership.deleted') {
            const orgId = evt.data.organization.id;
            const userId = evt.data.public_user_data.user_id;

            // Only clear it if the user is currently assigned to THIS org
            await User.findOneAndUpdate(
                { clerkId: userId, organizationId: orgId },
                {
                    organizationId: null,
                    organizationRole: null,
                }
            );
        }

        res.status(200).json({
            success: true,
            message: 'Webhook received',
        });
    } catch (error) {
        console.error('Error handling webhook event:', error);
        res.status(500).json({
            success: false,
            message: 'Internal Server Error'
        });
    }
};
