import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { isDbOutageError, DB_OUTAGE_MESSAGE } from '../utils/dbOutage';
import User, { IUser } from '../models/User.model';
import Organization from '../models/Organization.model';
import tokenService from '../services/token.service';
import { userAuthCache, orgStatusCache } from '../utils/cache.util';

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
                vehicle: any;
            };
        }
    }
}

const auth = () => async (req: Request, res: Response, next: NextFunction) => {
    try {
        // 1. Extract token
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

        if (!token) {
            throw new ApiError(401, 'Please authenticate');
        }

        // 2. Verify token
        const payload = tokenService.verifyAccessToken(token);
        const userId = payload.sub;

        if (!userId) {
            throw new ApiError(401, 'Invalid token payload');
        }

        // 3. Resolve user (cache-first)
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

        // 4. Resolve org context
        let orgId = user.organizationId?.toString();
        let orgRole = (user as any).organizationRole;

        // Super-admin impersonation
        if (user.role === 'super_admin') {
            const impersonateId = req.headers['x-impersonate-org-id'] as string;
            if (impersonateId) {
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
                orgRole = 'admin';
            }
        }

        // Boost global admins (not super_admins — they use impersonation instead)
        let finalOrgRole = orgRole;
        if (user.role === 'admin') {
            finalOrgRole = 'admin';
        }

        req.user = user as IUser;
        req.orgId = orgId;
        req.orgRole = finalOrgRole;

        req.auth = {
            userId,
            sessionId: 'local_session',
            orgId,
            orgRole: finalOrgRole,
            getToken: async () => token,
        };

        // 5. Account active check
        if (!user.isActive) {
            throw new ApiError(403, 'Account Suspended');
        }

        // 6. Whitelist check
        //
        // Routes in this list bypass the email-verification, onboarding, and
        // driver-approval gates below. Add a route here when it must be
        // reachable before the user has finished setting up their account.
        const url = req.originalUrl;

        const isAftermarketRequest  = url.includes('/api/aftermarket');
        const isAftermarketCheckout = isAftermarketRequest && url.includes('/api/aftermarket/checkout');
        const isAftermarketBrowse   = isAftermarketRequest && !isAftermarketCheckout;

        const isWhitelisted =
            // Onboarding flow — both steps must be reachable before onboarding is done
            url.includes('/api/auth/complete-onboarding') ||
            url.includes('/api/auth/select-onboarding-org') ||
            // Org list needed so the customer can pick a dealership in step 2
            url.includes('/api/organizations/public') ||
            // Standard always-open routes
            url.includes('/api/users/me') ||
            url.includes('/api/notifications') ||
            isAftermarketBrowse ||
            url.includes('/api/invitations/accept') ||
            url.includes('/api/push/subscribe') ||
            url.includes('/api/driver-requests/my-status');

        // 7. Onboarding gate
        if (!user.onboardingCompleted && !isWhitelisted) {
            throw new ApiError(403, 'Account setup incomplete. Please finish onboarding to access this feature.');
        }

        // 8. Email verification gate
        if (!user.emailVerified && !isWhitelisted) {
            throw new ApiError(403, 'Email not verified. Please verify your email to access this feature.');
        }

        // 9. Driver approval gate
        if (user.role === 'driver' && !user.isApproved && !isWhitelisted) {
            throw new ApiError(403, 'Your driver account is pending approval by an administrator.');
        }

        // 10. Organization suspension check (cache-first)
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

            if (status === 'suspended' && user.role !== 'super_admin') {
                throw new ApiError(403, 'Organization Suspended');
            }
        }

        next();
    } catch (error) {
        console.error('Auth Middleware Error:', error);
        if (error instanceof ApiError) {
            next(error);
        } else if (isDbOutageError(error)) {
            next(new ApiError(503, DB_OUTAGE_MESSAGE));
        } else {
            next(new ApiError(401, 'Please authenticate'));
        }
    }
};

export default auth;