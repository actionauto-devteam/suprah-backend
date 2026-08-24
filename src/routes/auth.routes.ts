import express from 'express';
import passport from 'passport';
import authController from '../controllers/auth.controller';
import { authLimiter, otpLimiter } from '../middleware/rate-limit.middleware';
import config from '../config';
import authMiddleware from '../middleware/auth.middleware';
import { isDbOutageError } from '../utils/dbOutage';
import { validateInviteLink, registerViaInvite } from '../controllers/customerInvite.controller';
import { submitDealershipInquiry } from '../controllers/dealershipInquiry.controller';

const router = express.Router();

router.post('/register', authLimiter, authController.register);
router.post('/register-dealership', authLimiter, authController.registerDealership);
router.post('/login', authLimiter, authController.login);
router.post('/verify-email', otpLimiter, authController.verifyEmail);
router.post('/resend-otp', otpLimiter, authController.resendOTP);
router.post('/refresh-tokens', authController.refreshTokens);
router.post('/logout', authController.logout);

router.post('/send-upgrade-otp', authController.sendUpgradeOTP);
router.post('/upgrade-legacy', authController.upgradeLegacyUser);

router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

router.get('/google', (req, res, next) => {
    const role = req.query.role as string;
    const redirect_url = req.query.redirect_url as string;
    const inviteToken = req.query.inviteToken as string;
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        state: JSON.stringify({ role, redirect_url, inviteToken }),
        session: false
    })(req, res, next);
});

router.get('/google/callback',
    (req: any, res, next) => {
        passport.authenticate('google', { session: false }, (err: any, user: any, info: any) => {
            if (err) {
                console.error('[Google Callback] Strategy error:', err);
                const code = isDbOutageError(err) ? 'service_unavailable' : 'oauth_failed';
                return res.redirect(`${config.frontendUrl}/sign-in?error=${code}`);
            }
            if (!user) {
                const code = info?.message === 'no_account' ? 'no_account' : 'oauth_failed';
                return res.redirect(`${config.frontendUrl}/sign-in?error=${code}`);
            }
            req.user = user;
            next();
        })(req, res, next);
    },
    async (req: any, res) => {
        try {
            console.log(`[Google Callback] Success for user: ${req.user?._id}`);

            // Extract redirect_url from state
            let redirect_url = '';
            try {
                if (req.query.state) {
                    const state = JSON.parse(req.query.state as string);
                    redirect_url = state.redirect_url || '';
                }
            } catch (e) {
                console.error('[Google Callback] Failed to parse state:', e);
            }

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

            console.log('[Google Callback] Redirecting to frontend with redirect_url:', redirect_url);
            // Redirect to frontend with Access Token and any preserved redirect_url
            let finalRedirect = `${config.frontendUrl}/auth/callback?token=${tokens.accessToken}`;
            if (redirect_url) {
                finalRedirect += `&redirect_url=${encodeURIComponent(redirect_url)}`;
            }

            res.redirect(finalRedirect);
        } catch (error) {
            console.error('[Google Callback] Error:', error);
            const code = isDbOutageError(error) ? 'service_unavailable' : 'oauth_failed';
            res.redirect(`${config.frontendUrl}/sign-in?error=${code}`);
        }
    }
);

router.post('/complete-onboarding', authMiddleware(), authController.completeOnboarding);
router.get('/crm-sso', authMiddleware(), authController.getCrmSsoToken);

// Customer invite link (public — no auth required)
router.get('/invite/:shortCode', validateInviteLink);
router.post('/invite/:shortCode/register', authLimiter, registerViaInvite);

// Dealership inquiry (public — no auth required)
router.post('/dealership-inquiries', authLimiter, submitDealershipInquiry);

export default router;
