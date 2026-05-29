import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import authService from '../services/auth.service';
import {
    registerSchema,
    loginSchema,
    registerDealershipSchema,
    verifyEmailSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
    completeOnboardingSchema
} from '../validations/auth.validation';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { userAuthCache, invalidateUserCache } from '../utils/cache.util';
import Organization from '../models/Organization.model';
import mongoose from 'mongoose';

class AuthController {
    /**
     * Register a new user
     */
    register = asyncHandler(async (req: Request, res: Response) => {
        const validatedData = registerSchema.parse(req.body);
        const result = await authService.register(validatedData);

        logger.info({ email: validatedData.email, emailSent: result.emailSent }, 'User registered');

        const message = result.emailSent
            ? 'Registration successful. Please verify your email.'
            : 'Registration successful. We could not send the verification email — please use Resend Code on the verification page.';

        res.status(201).json(
            new ApiResponse(201, { user: result.user, emailSent: result.emailSent }, message)
        );
    });

    /**
     * Verify email with OTP
     */
    verifyEmail = asyncHandler(async (req: Request, res: Response) => {
        const { email, otp } = verifyEmailSchema.parse(req.body);
        const result = await authService.verifyEmail(email, otp);

        const isProduction = process.env.NODE_ENV === 'production';
        res.cookie('refreshToken', result.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        await activityService.logLogin(
            result.user._id.toString(),
            result.user.organizationId?.toString(),
            req.ip,
            req.get('user-agent')
        );

        res.status(200).json(
            new ApiResponse(200, { user: result.user, accessToken: result.accessToken }, 'Email verified successfully')
        );
    });

    /**
     * Login
     */
    login = asyncHandler(async (req: Request, res: Response) => {
        const { email, password } = loginSchema.parse(req.body);
        const result = await authService.login(email, password);

        const isProduction = process.env.NODE_ENV === 'production';
        res.cookie('refreshToken', result.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        await activityService.logLogin(
            result.user._id.toString(),
            result.user.organizationId?.toString(),
            req.ip,
            req.get('user-agent')
        );

        logger.info({ userId: result.user._id, email }, 'User login successful');

        res.json(new ApiResponse(200, {
            user: result.user,
            accessToken: result.accessToken
        }, 'Login successful'));
    });

    /**
     * Register a new dealership
     */
    registerDealership = asyncHandler(async (req: Request, res: Response) => {
        const validatedData = registerDealershipSchema.parse(req.body);
        const result = await authService.registerDealership(validatedData);

        res.status(201).json(
            new ApiResponse(201, result, 'Dealership registered. Please verify your email.')
        );
    });

    /**
     * Send OTP to legacy user
     */
    sendUpgradeOTP = asyncHandler(async (req: Request, res: Response) => {
        const { email } = req.body;
        const result = await authService.sendUpgradeOTP(email);
        res.json(new ApiResponse(200, result, 'Verification code sent'));
    });

    /**
     * Complete legacy upgrade
     */
    upgradeLegacyUser = asyncHandler(async (req: Request, res: Response) => {
        const { email, otp, newPassword } = req.body;
        const result = await authService.upgradeLegacyUser(email, otp, newPassword);

        const isProduction = process.env.NODE_ENV === 'production';
        res.cookie('refreshToken', result.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        await activityService.createActivity({
            userId: result.user._id.toString(),
            organizationId: result.user.organizationId?.toString(),
            type: 'password_change',
            title: 'Account Upgraded',
            description: 'Legacy account upgraded with new password',
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });

        res.json(new ApiResponse(200, {
            user: result.user,
            accessToken: result.accessToken
        }, 'Account upgraded successfully'));
    });

    /**
     * Refresh Tokens
     */
    refreshTokens = asyncHandler(async (req: Request, res: Response) => {
        const refreshToken = req.cookies.refreshToken || req.body.refreshToken;

        if (!refreshToken) {
            return res.status(401).json(new ApiResponse(419, null, 'Refresh token missing'));
        }

        const tokens = await authService.refreshTokens(refreshToken);

        const isProduction = process.env.NODE_ENV === 'production';
        res.cookie('refreshToken', tokens.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        res.json(new ApiResponse(200, {
            accessToken: tokens.accessToken
        }, 'Tokens refreshed successfully'));
    });

    /**
     * Logout
     */
    logout = asyncHandler(async (req: Request, res: Response) => {
        const refreshToken = req.cookies.refreshToken || req.body.refreshToken;
        const user = req.user as any;

        if (refreshToken) {
            await authService.logout(refreshToken);
        }

        if (user) {
            await activityService.createActivity({
                userId: user._id.toString(),
                organizationId: user.organizationId?.toString(),
                type: 'logout',
                title: 'Signed Out',
                description: 'User successfully signed out',
                ipAddress: req.ip,
            });
            logger.info({ userId: user._id }, 'User logout');
        }

        res.clearCookie('refreshToken');
        res.json(new ApiResponse(200, null, 'Logged out successfully'));
    });

    /**
     * Forgot Password
     */
    forgotPassword = asyncHandler(async (req: Request, res: Response) => {
        const { email } = forgotPasswordSchema.parse(req.body);
        const result = await authService.sendForgotPasswordOTP(email);
        res.status(200).json(new ApiResponse(200, result, 'Reset code sent if account exists'));
    });

    /**
     * Reset Password
     */
    resetPassword = asyncHandler(async (req: Request, res: Response) => {
        const { email, otp, newPassword } = resetPasswordSchema.parse(req.body);
        const result = await authService.resetPassword(email, otp, newPassword) as any;

        await activityService.createActivity({
            userId: result.user._id.toString(),
            organizationId: result.user.organizationId?.toString(),
            type: 'password_change',
            title: 'Password Reset',
            description: 'Password was successfully reset via OTP',
            ipAddress: req.ip,
        });

        logger.info({ email }, 'Password reset successful');

        res.status(200).json(new ApiResponse(200, result, 'Password reset successfully'));
    });

    /**
     * Resend verification OTP
     */
    resendOTP = asyncHandler(async (req: Request, res: Response) => {
        const { email } = req.body;
        if (!email) throw new ApiError(400, 'Email is required');

        await authService.resendOTP(email);
        res.json(new ApiResponse(200, null, 'Verification code resent successfully'));
    });

    /**
     * Step 1 of customer onboarding — set role.
     *
     * - Dealers: flip onboardingCompleted immediately (they create their own org).
     * - Customers: set role only; onboardingCompleted stays false until
     *   selectOnboardingOrg is called in step 2.
     */
    completeOnboarding = asyncHandler(async (req: any, res: Response) => {
        const { role } = completeOnboardingSchema.parse(req.body);

        if (role === 'dealership') {
            // Delegate to the existing service — it handles org creation etc.
            const result = await authService.completeOnboarding(req.user._id, role);
            invalidateUserCache(req.user._id.toString());

            return res.status(200).json(
                new ApiResponse(200, { ...result, skipOrgSelect: true }, 'Onboarding completed successfully')
            );
        }

        // Customer path — set role but do NOT complete onboarding yet.
        // The user must pick an org in step 2 before the flag is flipped.
        const result = await authService.completeOnboarding(req.user._id, role, { skipComplete: true });
        invalidateUserCache(req.user._id.toString());

        res.status(200).json(
            new ApiResponse(200, { ...result, skipOrgSelect: false }, 'Role set. Please select your dealership.')
        );
    });

    /**
     * Step 2 of customer onboarding — link org and complete.
     *
     * Receives { organizationId } in the body.
     * Sets user.organizationId, user.organizationRole = 'member',
     * and flips onboardingCompleted = true.
     * Only callable by users whose role is 'customer' and whose
     * onboardingCompleted is still false.
     */
    selectOnboardingOrg = asyncHandler(async (req: any, res: Response) => {
        const { organizationId } = req.body;

        if (!organizationId) {
            throw new ApiError(400, 'organizationId is required');
        }

        const user = req.user;

        // Guard: only customers who haven't finished onboarding
        if (user.role !== 'customer') {
            throw new ApiError(403, 'Only customers need to select a dealership during onboarding');
        }

        if (user.onboardingCompleted) {
            throw new ApiError(409, 'Onboarding is already complete');
        }

        const org = await Organization.findById(organizationId);
        if (!org) {
            throw new ApiError(404, 'Organization not found');
        }
        if (org.status === 'suspended') {
            throw new ApiError(403, 'This dealership is currently unavailable');
        }

        user.organizationId = org._id as mongoose.Types.ObjectId;
        (user as any).organizationRole = 'member';
        user.onboardingCompleted = true;
        await user.save();

        invalidateUserCache(user._id.toString());

        await activityService.createActivity({
            userId: user._id.toString(),
            organizationId: org._id.toString(),
            type: 'other',
            title: 'Customer joined organization',
            description: `Customer completed onboarding and joined ${org.name}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });

        logger.info({ userId: user._id, orgId: org._id }, 'Customer completed onboarding with org');

        // Return the updated user (strip password just in case)
        const updatedUser = user.toObject ? user.toObject() : user;
        delete updatedUser.password;

        res.status(200).json(
            new ApiResponse(200, { user: updatedUser }, 'Onboarding completed successfully')
        );
    });

    /**
     * Handle OAuth Callback (Internal)
     */
    handleOAuthCallback = async (user: any) => {
        return await authService.handleOAuthCallback(user);
    };
}

export default new AuthController();