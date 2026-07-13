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
import { userAuthCache } from '../utils/cache.util';
import CrmUser from '../models/CrmUser.model';
import { generateCrmToken } from '../middleware/crmAuth.middleware';


class AuthController {
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

    registerDealership = asyncHandler(async (req: Request, res: Response) => {
        const validatedData = registerDealershipSchema.parse(req.body);
        const result = await authService.registerDealership(validatedData);

        res.status(201).json(
            new ApiResponse(201, result, 'Dealership registered. Please verify your email.')
        );
    });

    sendUpgradeOTP = asyncHandler(async (req: Request, res: Response) => {
        const { email } = req.body;
        const result = await authService.sendUpgradeOTP(email);
        res.json(new ApiResponse(200, result, 'Verification code sent'));
    });

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

    forgotPassword = asyncHandler(async (req: Request, res: Response) => {
        const { email } = forgotPasswordSchema.parse(req.body);
        const result = await authService.sendForgotPasswordOTP(email);
        res.status(200).json(new ApiResponse(200, result, 'Reset code sent if account exists'));
    });

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

    resendOTP = asyncHandler(async (req: Request, res: Response) => {
        const { email } = req.body;
        if (!email) throw new ApiError(400, 'Email is required');

        await authService.resendOTP(email);
        res.json(new ApiResponse(200, null, 'Verification code resent successfully'));
    });

    completeOnboarding = asyncHandler(async (req: any, res: Response) => {
        const { role } = completeOnboardingSchema.parse(req.body);
        const result = await authService.completeOnboarding(req.user._id, role);

        userAuthCache.delete(req.user._id.toString());

        res.status(200).json(
            new ApiResponse(200, result, 'Onboarding completed successfully')
        );
    });


    handleOAuthCallback = async (user: any) => {
        return await authService.handleOAuthCallback(user);
    };

    getCrmSsoToken = asyncHandler(async (req: Request, res: Response) => {
        const mainUser = (req as any).user;
        if (!mainUser?.email) throw new ApiError(401, 'Unauthorized');

        const crmUser = await CrmUser.findOne({ email: mainUser.email })
            .select('_id email fullName role')
            .lean();

        if (!crmUser) throw new ApiError(404, 'No CRM account found for this user. Contact your admin.');

        const token = generateCrmToken(crmUser._id.toString(), '30d');

        res.json(new ApiResponse(200, { token, crmUserId: crmUser._id.toString() }, 'CRM token issued'));
    });
}

export default new AuthController();