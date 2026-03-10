import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import Organization from '../models/Organization.model';
import tokenService from '../services/token.service';

// Extend Express Request type to include auth property for backward compatibility
declare global {
    namespace Express {
        interface Request {
            user?: IUser;
            orgId?: string;
            orgRole?: string;
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

/**
 * Custom Authentication Middleware
 * Replaces Clerk with local JWT verification
 */
const auth = () => async (req: Request, res: Response, next: NextFunction) => {
    try {
        // 1. Get the token from the header
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

        if (!token) {
            console.log('Auth Middleware: No token provided for path:', req.path);
            throw new ApiError(401, 'Please authenticate');
        }

        // 2. Verify the token using our TokenService
        const payload = tokenService.verifyAccessToken(token);

        // The 'sub' claim in our token is the MongoDB User ID
        const userId = payload.sub;

        if (!userId) {
            throw new ApiError(401, 'Invalid token payload');
        }

        // 3. Find user in local database
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(401, 'User not found');
        }

        // 4. Attach user and org info to request
        let orgId = user.organizationId?.toString();
        let orgRole = (user as any).organizationRole;

        // --- IMPERSONATION logic for Super Admins ---
        if (user.role === 'super_admin') {
            const impersonateId = req.headers['x-impersonate-org-id'] as string;
            if (impersonateId) {
                console.log(`[AUTH] Super Admin ${user.email} is impersonating Org: ${impersonateId}`);
                orgId = impersonateId;
                orgRole = 'admin'; // Assume admin role in the target org
            }
        }

        req.user = user;
        req.orgId = orgId;
        req.orgRole = orgRole;

        // 5. Compatibility Layer: req.auth
        // We populate this so existing controllers relying on req.auth won't break.
        req.auth = {
            userId: userId, // Local _id as string
            sessionId: 'local_session', // Dummy for now
            orgId,
            orgRole,
            getToken: async () => token,
        };

        // 6. Security Checks
        if (!user.isActive) {
            throw new ApiError(403, 'Account Suspended');
        }

        // 7. Email Verification Check
        // We whitelist strictly '/api/users/me' so the frontend can still fetch basic user info to show the verification screen.
        // We don't want to whitelist '/api/users/me/organizations' or other children.
        const isMeEndpoint = req.originalUrl.endsWith('/api/users/me') || req.originalUrl.endsWith('/api/users/me/');
        if (!user.emailVerified && !isMeEndpoint) {
            throw new ApiError(403, 'Email not verified. Please verify your email to access this feature.');
        }

        // 8. Driver Approval Check
        if (user.role === 'driver' && !user.isApproved && !isMeEndpoint) {
            throw new ApiError(403, 'Your driver account is pending approval by an administrator.');
        }

        // 9. Organization Suspension Check
        if (req.orgId) {
            const org = await Organization.findById(req.orgId).select('status');
            if (org && org.status === 'suspended') {
                // Super Admins can still access to fix things
                if (user.role !== 'super_admin') {
                    throw new ApiError(403, 'Organization Suspended');
                }
            }
        }

        next();
    } catch (error) {
        console.error('Auth Middleware Error:', error);
        if (error instanceof ApiError) {
            next(error);
        } else {
            next(new ApiError(401, 'Please authenticate'));
        }
    }
};

export default auth;
