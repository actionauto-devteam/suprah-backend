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
                orgId = impersonateId;
                orgRole = 'admin'; // Assume admin role in the target org
            }
        }

        // Boost global admins (but not super_admins, who handle authority via impersonation)
        let finalOrgRole = orgRole;
        if (user.role === 'admin') {
            finalOrgRole = 'admin';
        }

        req.user = user;
        req.orgId = orgId;
        req.orgRole = finalOrgRole;

        console.log(`[AuthMiddleware] User: ${user.email}, GlobalRole: ${user.role}, OrgId: ${orgId}, OrgRole: ${orgRole}`);

        // 5. Compatibility Layer: req.auth
        // We populate this so existing controllers relying on req.auth won't break.
        req.auth = {
            userId: userId, // Local _id as string
            sessionId: 'local_session', // Dummy for now
            orgId,
            orgRole: finalOrgRole,
            getToken: async () => token,
        };

        // 6. Security Checks
        if (!user.isActive) {
            throw new ApiError(403, 'Account Suspended');
        }

        // 7. Security Checks: Email Verification, Onboarding & Driver Approval
        const isWhitelisted =
            req.originalUrl.includes('/api/auth/complete-onboarding') ||
            req.originalUrl.includes('/api/users/me') ||
            req.originalUrl.includes('/api/notifications') ||
            req.originalUrl.includes('/api/invitations/accept') ||
            req.originalUrl.includes('/api/push/subscribe') ||
            req.originalUrl.includes('/api/driver-requests/my-status');

        if (!user.onboardingCompleted && !isWhitelisted) {
            throw new ApiError(403, 'Account setup incomplete. Please finish onboarding to access this feature.');
        }

        if (!user.emailVerified && !isWhitelisted) {
            throw new ApiError(403, 'Email not verified. Please verify your email to access this feature.');
        }

        // 8. Driver Approval Check
        if (user.role === 'driver' && !user.isApproved && !isWhitelisted) {
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
