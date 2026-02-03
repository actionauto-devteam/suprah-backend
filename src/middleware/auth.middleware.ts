import { Request, Response, NextFunction } from 'express';
import { clerkClient } from '@clerk/clerk-sdk-node';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';

// Extend Express Request type to include auth property from Clerk
declare global {
    namespace Express {
        interface Request {
            auth?: {
                userId: string;
                sessionId: string;
                getToken: () => Promise<string | null>;
            };
        }
    }
}

const auth = () => async (req: Request, res: Response, next: NextFunction) => {
    try {
        // 1. Get the token from the header
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            throw new ApiError(401, 'Please authenticate');
        }

        // 2. Verify the token using Clerk
        // Note: clerkClient.verifyToken verifies the signature and expiration
        const client = await clerkClient.verifyToken(token);

        // For legacy/migration support, we still need the actual user details to identify them
        // The verifyToken returns a decoded JWT payload.
        // The 'sub' claim is the clerk user ID.
        const clerkUserId = client.sub;

        if (!clerkUserId) {
            throw new ApiError(401, 'Invalid token');
        }

        // 3. Find user in local database
        let user = await User.findOne({ clerkId: clerkUserId });

        // 4. JIT (Just-In-Time) User Creation - "Bridge B"
        // If user doesn't exist locally (webhook failed or hasn't fired yet), create them.
        if (!user) {
            // Fetch full user details from Clerk API
            const clerkUser = await clerkClient.users.getUser(clerkUserId as string);

            const email = clerkUser.emailAddresses[0]?.emailAddress;
            const firstName = clerkUser.firstName || '';
            const lastName = clerkUser.lastName || '';
            const name = `${firstName} ${lastName}`.trim() || 'No Name';
            const picture = clerkUser.imageUrl;

            if (!email) {
                throw new ApiError(400, 'User must have an email address');
            }

            // Create local user
            user = await User.create({
                clerkId: clerkUserId,
                email,
                name,
                avatar: picture,
                emailVerified: true,
                role: 'user', // Default role
            });
        }

        // 5. Attach user to request
        req.user = user;

        // Optional: Attach Clerk auth info if needed by other middleware
        req.auth = {
            userId: clerkUserId as string,
            sessionId: client.sid as string,
            getToken: async () => token
        };

        next();
    } catch (error) {
        if (error instanceof ApiError) {
            next(error);
        } else {
            // Map Clerk errors or generic errors to 401
            next(new ApiError(401, 'Please authenticate'));
        }
    }
};

export default auth;
