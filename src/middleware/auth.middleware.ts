import { Request, Response, NextFunction } from 'express';
import { clerkClient } from '@clerk/clerk-sdk-node';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import Organization from '../models/Organization.model';

// Extend Express Request type to include auth property from Clerk
declare global {
    namespace Express {
        interface Request {
            auth?: {
                userId: string;
                sessionId: string;
                orgId?: string;
                orgRole?: string;
                getToken: () => Promise<string | null>;
            };
        }
    }
}

const auth = () => async (req: Request, res: Response, next: NextFunction) => {
    try {
        // 1. Get the token from the header
        console.log('Auth Middleware: Raw Authorization Header:', req.headers.authorization);
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            console.log('Auth Middleware: No token provided for path:', req.path, 'Method:', req.method);
            throw new ApiError(401, 'Please authenticate');
        }

        console.log('Auth Middleware: Verifying token...', token.substring(0, 10) + '...');

        // 2. Verify the token using Clerk
        // Note: clerkClient.verifyToken verifies the signature and expiration
        const client = await clerkClient.verifyToken(token);

        // For legacy/migration support, we still need the actual user details to identify them
        // The verifyToken returns a decoded JWT payload.
        // The 'sub' claim is the clerk user ID.
        const clerkUserId = client.sub;
        console.log('Auth Middleware: Clerk verification successful, sub:', clerkUserId);

        if (!clerkUserId) {
            throw new ApiError(401, 'Invalid token');
        }

        // 3. Find user in local database
        let user = await User.findOne({ clerkId: clerkUserId });
        if (user) {
            console.log('Auth Middleware: User found locally:', user._id);
        } else {
            console.log('Auth Middleware: User NOT found locally. Attempting JIT...');
        }

        // 4. JIT (Just-In-Time) User Creation - "Bridge B"
        // If user doesn't exist locally (webhook failed or hasn't fired yet), create them.
        if (!user) {
            // Fetch full user details from Clerk API
            console.log('Auth Middleware: Fetching user details from Clerk API...');
            const clerkUser = await clerkClient.users.getUser(clerkUserId as string);

            const email = clerkUser.emailAddresses[0]?.emailAddress;
            const firstName = clerkUser.firstName || '';
            const lastName = clerkUser.lastName || '';
            const name = `${firstName} ${lastName}`.trim() || 'No Name';
            const picture = clerkUser.imageUrl;

            if (!email) {
                throw new ApiError(400, 'User must have an email address');
            }

            // Check if user exists by email (to avoid duplicate key error)
            user = await User.findOne({ email });

            if (user) {
                // Link account: Update clerkId and other details
                console.log(`Linking existing user ${email} to new Clerk ID ${clerkUserId}`);
                user.clerkId = clerkUserId;
                user.name = name;
                user.avatar = picture;
                await user.save();
            } else {
                // Create local user
                console.log(`Creating new local user for ${email}`);
                user = await User.create({
                    clerkId: clerkUserId,
                    email,
                    name,
                    avatar: picture,
                    emailVerified: true,
                    role: 'user', // Default role
                });
            }
        }

        // 5. Attach user to request
        // WE NOW PRIORITIZE LOCAL DB FOR ORGANIZATION
        // We ignore client.org_id because we are managing orgs locally now.
        let orgId = user?.organizationId?.toString();
        let orgRole = user?.organizationRole;

        // 6. & 7. REMOVED - We no longer sync Organizations from Clerk.
        // The local database is now the Source of Truth for Organizations.

        req.user = user;
        req.orgId = orgId;
        req.orgRole = orgRole;

        // Optional: Attach Clerk auth info if needed by other middleware
        req.auth = {
            userId: clerkUserId as string,
            sessionId: client.sid as string,
            orgId,
            orgRole,
            getToken: async () => token
        };

        next();
    } catch (error) {
        console.error('Auth Middleware Verification Error:', error);
        if (error instanceof ApiError) {
            next(error);
        } else {
            // Map Clerk errors or generic errors to 401
            next(new ApiError(401, 'Please authenticate'));
        }
    }
};

export default auth;