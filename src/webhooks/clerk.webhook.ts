import { Webhook } from 'svix';
import { Request, Response } from 'express';
import User from '../models/User.model';
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
            // Logic for deletion
            await User.findOneAndDelete({ clerkId: id });
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
