import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import userService from '../services/user.service';
import tokenService from '../services/token.service';
import authService from '../services/auth.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import config from '../config';

const getCookieOptions = () => {
    const isDev = config.env === 'development';
    return {
        httpOnly: true,
        secure: !isDev, // True in production/staging
        sameSite: (isDev ? 'lax' : 'none') as 'lax' | 'none' | 'strict', // Explicit cast
        path: '/',
    };
};

const register = asyncHandler(async (req: Request, res: Response) => {
    const user = await userService.createUser(req.body);
    const tokens = await tokenService.generateAuthTokens(user);
    res.cookie('refreshToken', tokens.refresh.token, getCookieOptions());
    res.status(201).json(new ApiResponse(201, { user, tokens }, 'User registered successfully'));
});

const login = asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const user = await authService.loginUserWithEmailAndPassword(email, password);
    const tokens = await tokenService.generateAuthTokens(user);
    res.cookie('refreshToken', tokens.refresh.token, getCookieOptions());
    res.json(new ApiResponse(200, { user, tokens }, 'Login successful'));
});

const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email) {
        throw new ApiError(400, 'Email is required');
    }
    await authService.sendPasswordResetEmail(email);
    res.status(200).json(new ApiResponse(200, null, 'If an account with that email exists, a password reset link has been sent.'));
});

const resetPassword = asyncHandler(async (req: Request, res: Response) => {
    const { token, password } = req.body;

    if (!token || !password) {
        throw new ApiError(400, 'Token and new password are required');
    }

    await authService.resetPassword(token, password);

    res.status(200).json(new ApiResponse(200, null, 'Password has been reset successfully.'));
});

const logout = asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
    if (!refreshToken) {
        throw new ApiError(401, "Refresh token is required");
    }
    await authService.logout(refreshToken);
    res.clearCookie('refreshToken', { ...getCookieOptions(), maxAge: 0 });
    res.status(200).json(new ApiResponse(200, {}, 'Logout successful'));
});

const refreshTokens = asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
    if (!refreshToken) {
        throw new ApiError(401, "Please authenticate");
    }
    const tokens = await authService.refreshAuth(refreshToken);
    res.cookie('refreshToken', tokens.refresh.token, getCookieOptions());
    res.json(new ApiResponse(200, tokens, 'Tokens refreshed successfully'));
});

const getMe = asyncHandler(async (req: Request, res: Response) => {
    res.json(new ApiResponse(200, req.user, 'User details fetched successfully'));
});

export default {
    register,
    login,
    forgotPassword,
    resetPassword,
    logout,
    refreshTokens,
    getMe,
};
