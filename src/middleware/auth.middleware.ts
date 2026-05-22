import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import Organization from '../models/Organization.model';
import tokenService from '../services/token.service';
import { userAuthCache, orgStatusCache } from '../utils/cache.util';

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
            leadContext?: {
                organizationId: string;
                vehicle: any; // Using any for IVehicle to avoid circular dependency in declaration file
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

        // 3. Find user in local database (with TTL cache)
        const now = Date.now();
        let user: IUser | undefined | null;

        const cachedUser = userAuthCache.get(userId);
        if (cachedUser) {
            user = cachedUser;
        } else {
            user = await User.findById(userId);
            if (user) userAuthCache.set(userId, user);
        }

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
                // Validate impersonated orgId exists (cached)
                let orgExists = false;
                const cachedOrg = orgStatusCache.get(impersonateId);
                if (cachedOrg) {
                    orgExists = true;
                } else {
                    const org = await Organization.findById(impersonateId).select('status');
                    if (org) {
                        orgStatusCache.set(impersonateId, { status: org.status });
                        orgExists = true;
                    }
                }

                if (!orgExists) {
                    throw new ApiError(400, 'Invalid impersonation: Organization not found');
                }

                orgId = impersonateId;
                orgRole = 'admin'; // Assume admin role in the target org
            }
        }

        // Boost global admins (but not super_admins, who handle authority via impersonation)
        let finalOrgRole = orgRole;
        if (user.role === 'admin') {
            finalOrgRole = 'admin';
        }

        req.user = user as IUser;
        req.orgId = orgId;
        req.orgRole = finalOrgRole;

        // 5. Compatibility Layer: req.auth
        req.auth = {
            userId: userId,
            sessionId: 'local_session',
            orgId,
            orgRole: finalOrgRole,
            getToken: async () => token,
        };

        // 6. Security Checks
        if (!user.isActive) {
            throw new ApiError(403, 'Account Suspended');
        }

        // 7. Security Checks: Email Verification, Onboarding & Driver Approval
        //
        // Whitelisted routes bypass the onboarding / email-verification gates.
        // NOTE on aftermarket: we open the *browse* endpoints so customers can
        // window-shop before finishing onboarding, but we intentionally do NOT
        // whitelist checkout — placing an order still requires a verified,
        // onboarded account (handled by the explicit !isAftermarketCheckout
        // guard below).
        const url = req.originalUrl;

        // Is this an aftermarket request, and if so is it the checkout action?
        const isAftermarketRequest = url.includes('/api/aftermarket');
        const isAftermarketCheckout =
            isAftermarketRequest && url.includes('/api/aftermarket/checkout');

        // Aftermarket browse/read is whitelisted; checkout is explicitly excluded.
        const isAftermarketBrowse = isAftermarketRequest && !isAftermarketCheckout;

        const isWhitelisted =
            url.includes('/api/auth/complete-onboarding') ||
            url.includes('/api/users/me') ||
            url.includes('/api/notifications') ||
            isAftermarketBrowse ||
            url.includes('/api/invitations/accept') ||
            url.includes('/api/push/subscribe') ||
            url.includes('/api/driver-requests/my-status');

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

        // 9. Organization Suspension Check (with TTL cache)
        if (req.orgId) {
            let status: string | undefined;
            const cachedOrg = orgStatusCache.get(req.orgId);

            if (cachedOrg) {
                status = cachedOrg.status;
            } else {
                const org = await Organization.findById(req.orgId).select('status');
                if (org) {
                    status = org.status;
                    orgStatusCache.set(req.orgId, { status: org.status });
                }
            }

            if (status === 'suspended') {
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