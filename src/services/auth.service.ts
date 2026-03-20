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
    async register(userData: { name: string; email: string; password: string; role?: string; inviteToken?: string }) {
        const { email, password, name, role, inviteToken } = userData;

        const existingUser = await User.findOne({ email: email?.toLowerCase() });
        if (existingUser) {
            throw new ApiError(400, 'User with this email already exists');
        }

        let roleToAssign = role === 'dealership' ? 'admin' : (role || 'customer');
        let orgId = undefined;
        let orgRole = undefined;
        let onboardingCompleted = true; // Default true if role is picked
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
                    onboardingCompleted = true;
                    isApproved = true;

                    // Mark invite as accepted
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
            // 'member' invite -> 'employee' global role
            let finalGlobalRole = roleToAssign;
            if (roleToAssign === 'member') {
                finalGlobalRole = 'employee';
            }

            const user = await User.create({
                email: email?.toLowerCase(),
                password, // Hashed via pre-save hook
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

            // Generate and send OTP for verification
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.otpCode = otp;
            user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
            await user.save();

            await emailService.sendEmail({
                to: user.email,
                subject: 'Verify Your Action Auto Account',
                text: `Your verification code is: ${otp}`,
                html: `<h1>Account Verification</h1><p>Welcome to Action Auto! Your verification code is: <strong>${otp}</strong></p>`
            });

            // Do NOT return tokens yet - user must verify first
            return { user: this.sanitizeUser(user) };
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

        // Generate and send new OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
        await user.save();

        await emailService.sendEmail({
            to: user.email,
            subject: 'Your Action Auto Verification Code',
            text: `Your verification code is: ${otp}`,
            html: `<h1>Verify Your Account</h1><p>Your verification code is: <strong>${otp}</strong>. This code will expire in 15 minutes.</p>`
        });

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
            // 1. Create User
            const existingUser = await User.findOne({ email: email.toLowerCase() }).session(session);
            if (existingUser) {
                throw new ApiError(400, 'User with this email already exists');
            }

            // Dealership slug must be unique
            const existingOrg = await Organization.findOne({ slug: dealershipSlug }).session(session);
            if (existingOrg) {
                throw new ApiError(400, 'Dealership slug is already taken');
            }

            const user = new User({
                email: email.toLowerCase(),
                password,
                name,
                role: 'admin', // Owner is an admin of their org
                emailVerified: false,
                onboardingCompleted: true,
            });
            await user.save({ session });

            // 2. Create Organization
            const organization = new Organization({
                name: dealershipName,
                slug: dealershipSlug,
                ownerId: user._id,
                members: [user._id],
            });
            await organization.save({ session });

            // 3. Link User to Organization
            user.organizationId = organization._id as any;
            user.organizationRole = 'owner';

            // Generate OTP
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

        // Detect Legacy Clerk User (Phase 4 Logic)
        if (!user.password && !user.googleId) {
            throw new ApiError(401, 'LEGACY_USER_UPGRADE_REQUIRED');
        }

        if (!password) {
            throw new ApiError(401, 'Password required');
        }

        // If user has no password but HAS a googleId, prompt them to use Google
        if (!user.password && user.googleId) {
            throw new ApiError(401, 'Please sign in with Google');
        }

        // Fallback for any other case where password is missing
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
        user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
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
        // user.clerkId = undefined; // We KEEP it for now (Phase 6 Purge rule)
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

        // Rotate Refresh Token (Strict Security)
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
            // We return success even if user not found for security (avoid enumeration)
            // But we don't actually send an email.
            return { message: 'If an account exists, a reset code has been sent' };
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
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

        return { message: 'Password reset successfully' };
    }

    /**
     * Handle OAuth (Google) Callback Logic
     */
    async handleOAuthCallback(user: IUser) {
        return await this.generateAuthTokens(user);
    }

    /**
     * Complete onboarding - set role and mark as completed
     */
    async completeOnboarding(userId: string, role: string) {
        const user = await User.findById(userId);
        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        if (user.onboardingCompleted) {
            throw new ApiError(400, 'Onboarding already completed');
        }

        const roleToAssign = role === 'dealership' ? 'admin' : (role || 'customer');
        user.role = roleToAssign as any;
        user.onboardingCompleted = true;

        // Drivers need approval
        if (roleToAssign === 'driver') {
            user.isApproved = false;
            await this.ensureDriverRequest(user);
        }

        await user.save();
        return this.sanitizeUser(user);
    }

    // -- Private Helpers --

    private async ensureDriverRequest(user: IUser) {
        try {
            const existingRequest = await DriverRequest.findOne({ driverUserId: user._id, status: 'pending' });
            if (!existingRequest) {
                const driverRequest = await DriverRequest.create({
                    driverUserId: user._id,
                    status: 'pending'
                });

                // Notify Super Admins
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
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

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
