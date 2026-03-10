import express from 'express';
import passport from 'passport';
import authController from '../controllers/auth.controller';
import { authLimiter, otpLimiter } from '../middleware/rate-limit.middleware';
import config from '../config';

const router = express.Router();

// Public Routes with Rate Limiting
router.post('/register', authLimiter, authController.register);
router.post('/register-dealership', authLimiter, authController.registerDealership);
router.post('/login', authLimiter, authController.login);
router.post('/verify-email', otpLimiter, authController.verifyEmail);
router.post('/resend-otp', otpLimiter, authController.resendOTP);
router.post('/refresh-tokens', authController.refreshTokens);
router.post('/logout', authController.logout);

// Legacy Upgrade Flow
router.post('/send-upgrade-otp', authController.sendUpgradeOTP);
router.post('/upgrade-legacy', authController.upgradeLegacyUser);

// Forgot Password
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: `${config.frontendUrl}/login?error=oauth_failed`, session: false }),
    async (req: any, res) => {
        // req.user is populated by Passport
        const tokens = await authController.handleOAuthCallback(req.user);

        const isProduction = process.env.NODE_ENV === 'production';
        // Set Refresh Token in Cookie
        res.cookie('refreshToken', tokens.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        // Redirect to frontend with Access Token (or signal success)
        res.redirect(`${config.frontendUrl}/auth/callback?token=${tokens.accessToken}`);
    }
);

export default router;
