import passport from 'passport';
import mongoose from 'mongoose';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import config from './index';
import User from '../models/User.model';

passport.use(
    new GoogleStrategy(
        {
            clientID: config.google.clientId || 'dummy-client-id',
            clientSecret: config.google.clientSecret || 'dummy-client-secret',
            callbackURL: `${config.backendUrl}/api/auth/google/callback`,
            passReqToCallback: true,
        },
        async (req: any, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
            try {
                // 1. Extract context from state first
                let requestedRole: string | undefined;
                let inviteToken: string | undefined;
                try {
                    if (req.query.state) {
                        const state = JSON.parse(req.query.state as string);
                        requestedRole = state.role;
                        inviteToken = state.inviteToken;
                    }
                } catch (e) {
                    console.error('Passport Google Strategy: Failed to parse state', e);
                }

                // 2. Prepare default values based on requested role
                let roleToAssign = requestedRole === 'dealership' ? 'admin' : (requestedRole || 'customer');
                let orgId = undefined;
                let orgRole = undefined;
                let onboardingCompleted = !!requestedRole;
                let isApproved = roleToAssign !== 'driver';

                // 3. Process Invitation if present
                if (inviteToken) {
                    const InvitationModel = mongoose.model('Invitation');
                    const invite: any = await InvitationModel.findOne({ token: inviteToken, status: 'pending' });

                    if (invite) {
                        // Normalize roles
                        if (invite.role === 'admin' || invite.role === 'member') {
                            roleToAssign = invite.role === 'admin' ? 'admin' : 'employee';
                        } else {
                            roleToAssign = invite.role;
                        }

                        orgId = invite.organizationId;
                        orgRole = invite.role;
                        onboardingCompleted = true;
                        isApproved = true;

                        // Mark invite as accepted
                        invite.status = 'accepted';
                        await invite.save();
                    }
                }

                const email = profile.emails?.[0].value;
                if (!email) {
                    console.error('[Google Auth] No email found in profile');
                    return done(new Error('No email found in Google profile'), undefined);
                }

                let user = await User.findOne({
                    $or: [
                        { googleId: profile.id },
                        { email: email.toLowerCase() }
                    ]
                });

                if (user) {
                    // Update Google ID if it was missing (account linking)
                    if (!user.googleId) user.googleId = profile.id;

                    // If we have an invite, promote the existing user
                    if (inviteToken && orgId) {
                        user.role = roleToAssign as any;
                        user.organizationId = orgId;
                        user.organizationRole = orgRole;
                        user.onboardingCompleted = true;
                        user.isApproved = true;
                    }

                    // Legacy onboarding check
                    if (user.onboardingCompleted === undefined || user.onboardingCompleted === null) {
                        user.onboardingCompleted = user.role !== 'customer';
                    }

                    await user.save();
                    return done(null, user);
                }

                // No existing account found.
                // Only allow account creation through a valid invitation link.
                // Without an invite, Google sign-in is blocked — accounts must be
                // created by a representative first.
                if (!inviteToken || !orgId) {
                    return done(null, false, { message: 'no_account' });
                }

                // Valid invite present — create the account
                user = await User.create({
                    googleId: profile.id,
                    email: email.toLowerCase(),
                    name: profile.displayName || email.split('@')[0],
                    avatar: profile.photos?.[0].value,
                    role: roleToAssign,
                    organizationId: orgId,
                    organizationRole: orgRole,
                    emailVerified: true,
                    isApproved,
                    onboardingCompleted,
                });

                done(null, user);
            } catch (error) {
                console.error('[Google Auth] Error in verify callback:', error);
                done(error, undefined);
            }
        }
    )
);

// We are using stateless JWTs, but Passport still expects these for some strategies
passport.serializeUser((user: any, done) => {
    done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (error) {
        done(error, null);
    }
});

export default passport;
