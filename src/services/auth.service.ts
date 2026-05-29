import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import User, { IUser } from '../models/User.model';
import Session from '../models/Session.model';
import tokenService from './token.service';
import emailService from './email.service';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';
import Organization from '../models/Organization.model';
import DriverRequest from '../models/DriverRequest.model';
import notificationService from './notification.service';

class AuthService {
    async register(userData: {
        name: string;
        email: string;
        password: string;
        role?: string;
        inviteToken?: string;
        organizationId?: string;
        dealershipSlug?: string;
    }) {
        const { email, password, name, role, inviteToken, organizationId, dealershipSlug } = userData;

        const existingUser = await User.findOne({ email: email?.toLowerCase() });
        if (existingUser) {
            throw new ApiError(400, 'User with this email already exists');
        }

        let roleToAssign = role === 'dealership' ? 'admin' : (role || 'customer');
        let orgId: mongoose.Types.ObjectId | undefined = undefined;
        let orgRole = undefined;
        let onboardingCompleted = false; // Always false on register — completed via onboarding flow
        let isApproved = true;

        try {
            // If registering via invitation
            if (inviteToken) {
                const InvitationModel = mongoose.model('Invitation');
                const invite: any = await InvitationModel.findOne({ token: inviteToken, status: 'pending' });

                if (invite) {
                    roleToAssign = invite.role;
                    orgId = invite.organizationId;
                    orgRole = invite.role;
                    onboardingCompleted = true; // Invited users skip onboarding
                    isApproved = true;

                    invite.status = 'accepted';
                    await invite.save();
                } else {
                    console.error('[AuthService] Invitation not found or already accepted:', inviteToken);
                }
            }

            if (roleToAssign === 'driver' && !inviteToken) {
                isApproved = false;
            }

            // Map internal roles correctly for DB
            let finalGlobalRole = roleToAssign;
            if (roleToAssign === 'member') {
                finalGlobalRole = 'employee';
            }

            // Invited users or non-customers can still get org resolved here.
            // Regular customers now pick their org explicitly in the onboarding
            // org-select step, so we skip the auto-resolve for them.
            if (!orgId && finalGlobalRole !== 'customer') {
                // Non-customer roles (employee, admin, driver via invite etc.)
                // still benefit from the existing slug/id resolution.
                orgId = await this.resolveCustomerOrgId({ organizationId, dealershipSlug });
            }

            const user = await User.create({
                email: email?.toLowerCase(),
                password,
                name,
                role: finalGlobalRole,
                organizationId: orgId,
                organizationRole: orgRole,
                emailVerified: false,
                isApproved,
                onboardingCompleted,
            });

            if (finalGlobalRole === 'driver' && !inviteToken) {
                await this.ensureDriverRequest(user as any);
            }

            // Generate and send OTP for email verification
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.otpCode = otp;
            user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
            await user.save();

            let emailSent = true;
            try {
                await emailService.sendEmail({
                    to: user.email,
                    subject: 'Verify Your Action Auto Account',
                    text: `Your verification code is: ${otp}`,
                    html: `<h1>Account Verification</h1><p>Welcome to Action Auto! Your verification code is: <strong>${otp}</strong></p>`
                });
            } catch (emailErr) {
                console.error('[AuthService] Failed to send verification email:', emailErr);
                emailSent = false;
            }

            return { user: this.sanitizeUser(user), emailSent };
        } catch (error) {
            console.error('[AuthService] Register Error:', error);
            throw error;
        }
    }

    /**
     * Verify email with OTP
     */
    async verifyEmail(email: string, otp: string) {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user || user.otpCode !== otp || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
            throw new ApiError(400, 'Invalid or expired verification code');
        }

        user.emailVerified = true;
        user.otpCode = undefined;
        user.otpExpiresAt = undefined;
        await user.save();

        const tokens = await this.generateAuthTokens(user);
        return { user: this.sanitizeUser(user), ...tokens };
    }

    /**
     * Resend verification OTP
     */
    async resendOTP(email: string) {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        if (user.emailVerified) {
            throw new ApiError(400, 'Email is already verified');
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        try {
            await emailService.sendEmail({
                to: user.email,
                subject: 'Your Action Auto Verification Code',
                text: `Your verification code is: ${otp}`,
                html: `<h1>Verify Your Account</h1><p>Your verification code is: <strong>${otp}</strong>. This code will expire in 15 minutes.</p>`
            });
        } catch (emailErr) {
            console.error('[AuthService] Failed to resend OTP email:', emailErr);
            throw new ApiError(500, 'Could not send verification email. Please try again later.');
        }

        return { message: 'New verification code sent' };
    }

    /**
     * Register a new dealership (User + Organization)
     */
    async registerDealership(data: any) {
        const { name, email, password, dealershipName, dealershipSlug } = data;

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const existingUser = await User.findOne({ email: email.toLowerCase() }).session(session);
            if (existingUser) {
                throw new ApiError(400, 'User with this email already exists');
            }

            const existingOrg = await Organization.findOne({ slug: dealershipSlug }).session(session);
            if (existingOrg) {
                throw new ApiError(400, 'Dealership slug is already taken');
            }

            const user = new User({
                email: email.toLowerCase(),
                password,
                name,
                role: 'admin',
                emailVerified: false,
                onboardingCompleted: true, // Dealership registration is a single complete flow
            });
            await user.save({ session });

            const organization = new Organization({
                name: dealershipName,
                slug: dealershipSlug,
                ownerId: user._id,
                members: [user._id],
            });
            await organization.save({ session });

            user.organizationId = organization._id as any;
            user.organizationRole = 'owner';

            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.otpCode = otp;
            user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
            await user.save({ session });

            await session.commitTransaction();

            await emailService.sendEmail({
                to: user.email,
                subject: 'Verify Your Dealership Account',
                text: `Your verification code is: ${otp}`,
                html: `<h1>Dealership Verification</h1><p>Your verification code is: <strong>${otp}</strong></p>`
            });

            return {
                user: this.sanitizeUser(user),
                organization,
                status: 'pending_verification'
            };
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Login with local credentials
     */
    async login(email: string, password?: string) {
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

        if (!user) {
            throw new ApiError(401, 'Invalid email or password');
        }

        if (!user.password && !user.googleId) {
            throw new ApiError(401, 'LEGACY_USER_UPGRADE_REQUIRED');
        }

        if (!password) {
            throw new ApiError(401, 'Password required');
        }

        if (!user.password && user.googleId) {
            throw new ApiError(401, 'Please sign in with Google');
        }

        if (!user.password) {
            throw new ApiError(401, 'Invalid email or password');
        }

        const isMatch = await user.isPasswordMatch(password);
        if (!isMatch) {
            throw new ApiError(401, 'Invalid email or password');
        }

        const tokens = await this.generateAuthTokens(user);
        return { user: this.sanitizeUser(user), ...tokens };
    }

    /**
     * Send OTP to legacy user
     */
    async sendUpgradeOTP(email: string) {
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
        if (!user || user.password || user.googleId) {
            throw new ApiError(404, 'User not found or not a legacy user');
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        await emailService.sendEmail({
            to: user.email,
            subject: 'Your Action Auto Security Code',
            text: `Your upgrade code is: ${otp}. This code expires in 15 minutes.`,
            html: `<h1>Security Upgrade</h1><p>Your security code is: <strong>${otp}</strong></p><p>Use this to set your new account password.</p>`
        });

        return { message: 'OTP sent to email' };
    }

    /**
     * Upgrade legacy user with OTP and new password
     */
    async upgradeLegacyUser(email: string, otp: string, newPassword: string) {
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
        if (!user || user.otpCode !== otp || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
            throw new ApiError(400, 'Invalid or expired OTP');
        }

        user.password = newPassword;
        user.otpCode = undefined;
        user.otpExpiresAt = undefined;
        await user.save();

        const tokens = await this.generateAuthTokens(user);
        return { user: this.sanitizeUser(user), ...tokens };
    }

    /**
     * Refresh tokens
     */
    async refreshTokens(refreshToken: string) {
        const payload = tokenService.verifyRefreshToken(refreshToken);
        const refreshTokenHash = this.hashToken(refreshToken);

        const session = await Session.findOne({ refreshTokenHash, userId: payload.sub });
        if (!session) {
            throw new ApiError(401, 'Invalid refresh token');
        }

        const user = await User.findById(payload.sub);
        if (!user) {
            throw new ApiError(401, 'User not found');
        }

        await session.deleteOne();
        const tokens = await this.generateAuthTokens(user);
        return tokens;
    }

    /**
     * Logout
     */
    async logout(refreshToken: string) {
        const refreshTokenHash = this.hashToken(refreshToken);
        await Session.findOneAndDelete({ refreshTokenHash });
    }

    /**
     * Send OTP for forgot password
     */
    async sendForgotPasswordOTP(email: string) {
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
        if (!user) {
            return { message: 'If an account exists, a reset code has been sent' };
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        await emailService.sendEmail({
            to: user.email,
            subject: 'Reset Your Action Auto Password',
            text: `Your password reset code is: ${otp}. This code expires in 15 minutes.`,
            html: `<h1>Reset Password</h1><p>Your password reset code is: <strong>${otp}</strong></p><p>Use this to set a new password for your account.</p>`
        });

        return { message: 'If an account exists, a reset code has been sent' };
    }

    /**
     * Reset password with OTP
     */
    async resetPassword(email: string, otp: string, newPassword: string) {
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

        if (!user || user.otpCode !== otp || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
            throw new ApiError(400, 'Invalid or expired reset code');
        }

        user.password = newPassword;
        user.otpCode = undefined;
        user.otpExpiresAt = undefined;
        await user.save();

        return { user: this.sanitizeUser(user), message: 'Password reset successfully' };
    }

    /**
     * Handle OAuth (Google) Callback Logic
     */
    async handleOAuthCallback(user: IUser) {
        return await this.generateAuthTokens(user);
    }

    /**
     * Step 1 of onboarding — set role.
     *
     * For dealers this also flips onboardingCompleted immediately since
     * they create their own org and don't need the org-select step.
     *
     * For customers, pass { skipComplete: true } from the controller so
     * onboardingCompleted stays false until selectOnboardingOrg is called.
     */
    async completeOnboarding(userId: string, role: string, options?: { skipComplete?: boolean }) {
        const user = await User.findById(userId);
        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        // Allow re-entry if only the role was set but onboarding isn't done yet
        // (i.e. customer who set role but hasn't picked an org).
        // Block true re-entry where onboarding is already fully complete.
        if (user.onboardingCompleted) {
            throw new ApiError(400, 'Onboarding already completed');
        }

        const roleToAssign = role === 'dealership' ? 'admin' : (role || 'customer');
        user.role = roleToAssign as any;

        if (roleToAssign === 'driver') {
            user.isApproved = false;
            await this.ensureDriverRequest(user);
        }

        // Only flip the flag when we're not deferring to the org-select step.
        // Dealers finish here; customers finish in selectOnboardingOrg.
        if (!options?.skipComplete) {
            user.onboardingCompleted = true;
        }

        await user.save();
        return this.sanitizeUser(user);
    }

    // -- Private Helpers --

    /**
     * Resolve which dealership Organization a new customer belongs to.
     * Priority: explicit id → slug → single-org deployment fallback.
     * Returns undefined when it genuinely can't be determined.
     */
    private async resolveCustomerOrgId(opts: {
        organizationId?: string;
        dealershipSlug?: string;
    }): Promise<mongoose.Types.ObjectId | undefined> {
        if (opts.organizationId && mongoose.isValidObjectId(opts.organizationId)) {
            const org = await Organization.findById(opts.organizationId).select('_id');
            if (org) return org._id as any;
        }

        if (opts.dealershipSlug) {
            const org = await Organization.findOne({ slug: opts.dealershipSlug }).select('_id');
            if (org) return org._id as any;
        }

        const orgCount = await Organization.countDocuments({});
        if (orgCount === 1) {
            const only = await Organization.findOne().select('_id');
            if (only) return only._id as any;
        }

        return undefined;
    }

    private async ensureDriverRequest(user: IUser) {
        try {
            const existingRequest = await DriverRequest.findOne({ driverUserId: user._id, status: 'pending' });
            if (!existingRequest) {
                const driverRequest = await DriverRequest.create({
                    driverUserId: user._id,
                    status: 'pending'
                });

                const superAdmins = await User.find({ role: 'super_admin' });
                for (const admin of superAdmins) {
                    await notificationService.createNotification({
                        userId: admin._id.toString(),
                        organizationId: admin.organizationId?.toString() || 'global',
                        type: 'driver_request',
                        title: 'New Driver Request',
                        message: `${user.name} (${user.email}) has requested to join as a driver.`,
                        metadata: {
                            driverRequestId: driverRequest._id.toString(),
                            driverName: user.name,
                            driverEmail: user.email
                        }
                    }).catch(err => console.error('[AuthService] Notification failed:', err));
                }
            }
        } catch (err) {
            console.error('[AuthService] Failed to create driver request:', err);
        }
    }

    private async generateAuthTokens(user: IUser) {
        const accessToken = tokenService.generateAccessToken(user);
        const refreshToken = tokenService.generateRefreshToken(user);

        const refreshTokenHash = this.hashToken(refreshToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await Session.create({
            userId: user._id,
            refreshTokenHash,
            expiresAt
        });

        return { accessToken, refreshToken };
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private sanitizeUser(user: IUser) {
        const userObj = user.toObject();
        delete userObj.password;
        delete userObj.otpCode;
        delete userObj.otpExpiresAt;
        return userObj;
    }
}

export default new AuthService();