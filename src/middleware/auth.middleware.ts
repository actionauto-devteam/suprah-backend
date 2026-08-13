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
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

        if (!token) {
            throw new ApiError(401, 'Please authenticate');
        }

        const payload = tokenService.verifyAccessToken(token);
        const userId = payload.sub;

        if (!userId) {
            throw new ApiError(401, 'Invalid token payload');
        }

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

        let orgId = user.organizationId?.toString();
        let orgRole = (user as any).organizationRole;

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

        if (!user.isActive) {
            throw new ApiError(403, 'Account Suspended');
        }

        const url = req.originalUrl;

        const isAftermarketRequest  = url.includes('/api/aftermarket');
        const isAftermarketCheckout = isAftermarketRequest && url.includes('/api/aftermarket/checkout');
        const isAftermarketBrowse   = isAftermarketRequest && !isAftermarketCheckout;

        const isWhitelisted =
            url.includes('/api/auth/complete-onboarding') ||
            url.includes('/api/auth/select-onboarding-org') ||
            url.includes('/api/organizations/public') ||
            url.includes('/api/users/me') ||
            url.includes('/api/notifications') ||
            isAftermarketBrowse ||
            url.includes('/api/invitations/accept') ||
            url.includes('/api/push/subscribe') ||
            url.includes('/api/driver-requests/my-status') ||
            // Driver's Account application wizard (documents/compliance/
            // agreement) must be reachable before admin approval — that's
            // the whole point of it existing.
            url.includes('/api/driver-profile');

        if (!user.onboardingCompleted && !isWhitelisted) {
            throw new ApiError(403, 'Account setup incomplete. Please finish onboarding to access this feature.');
        }

        if (!user.emailVerified && !isWhitelisted) {
            throw new ApiError(403, 'Email not verified. Please verify your email to access this feature.');
        }

        if (user.role === 'driver' && !user.isApproved && !isWhitelisted) {
            throw new ApiError(403, 'Your driver account is pending approval by an administrator.');
        }

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
            // Unexpected server-side failure — NOT an auth problem.
            // Previously this returned 401, which made the frontend
            // interceptor attempt a refresh, retry, hit the same error,
            // receive a second 401 on the _retry request, and log the
            // user out. A transient server error must never masquerade
            // as an authentication failure. (Same rule already applied
            // to crmAuth: unexpected errors → 500, not 401.)
            next(new ApiError(500, 'Internal authentication error'));
        }
    }
};

export default auth;