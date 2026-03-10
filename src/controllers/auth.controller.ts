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

class AuthController {
    /**
     * Register a new user
     */
    register = asyncHandler(async (req: Request, res: Response) => {
        const validatedData = registerSchema.parse(req.body);
        const result = await authService.register(validatedData);

        res.status(201).json(
            new ApiResponse(201, result, 'Registration successful. Please verify your email.')
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

        if (refreshToken) {
            await authService.logout(refreshToken);
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
        const result = await authService.resetPassword(email, otp, newPassword);
        res.status(200).json(new ApiResponse(200, result, 'Password reset successfully'));
    });

    /**
     * Handle OAuth Callback (Internal)
     */
    /**
     * Resend verification OTP
     */
    resendOTP = asyncHandler(async (req: Request, res: Response) => {
        const { email } = req.body;
        if (!email) throw new ApiError(400, 'Email is required');

        await authService.resendOTP(email);
        res.json(new ApiResponse(200, null, 'Verification code resent successfully'));
    });

    completeOnboarding = asyncHandler(async (req: any, res: Response) => {
        const { role } = completeOnboardingSchema.parse(req.body);
        const result = await authService.completeOnboarding(req.user._id, role);

        res.status(200).json(
            new ApiResponse(200, result, 'Onboarding completed successfully')
        );
    });

    handleOAuthCallback = async (user: any) => {
        return await authService.handleOAuthCallback(user);
    };
}

export default new AuthController();
