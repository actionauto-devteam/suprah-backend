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

                const email = profile.emails?.[0].value;
                if (!email) {
                    console.error('[Google Auth] No email found in profile');
                    return done(new Error('No email found in Google profile'), undefined);
                }

                // 3. Process Invitation if present. An invite only applies if it
                // was actually sent to the Google account that's signing in —
                // otherwise anyone holding a still-pending invite link could get
                // promoted into (or create an 3account inside) someone else's org.
                let usedInvite: any = null;
                if (inviteToken) {
                    const InvitationModel = mongoose.model('Invitation');
                    const invite: any = await InvitationModel.findOne({ token: inviteToken, status: 'pending' });

                    // An expired invitation, or a leftover driver one, doesn't
                    // apply, the same as signing up with email (2026-11-11).
                    const expired = Boolean(invite?.expiresAt) && new Date(invite.expiresAt).getTime() < Date.now();
                    if (invite && !expired && invite.role !== 'driver' && invite.email.toLowerCase().trim() === email.toLowerCase().trim()) {
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

                        // Marked as accepted once the account is saved below.
                        usedInvite = invite;
                    }
                }

                let user = await User.findOne({
                    $or: [
                        { googleId: profile.id },
                        { email: email.toLowerCase() }
                    ]
                });

                // A driver account can't become dealership staff (2026-11-11):
                // the invitation stays unused and the driver signs in as usual.
                if (user && user.role === 'driver' && usedInvite) {
                    usedInvite = null;
                    orgId = undefined;
                }

                const markInviteAccepted = async () => {
                    if (!usedInvite) return;
                    usedInvite.status = 'accepted';
                    await usedInvite.save();
                };

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
                    await markInviteAccepted();
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
                await markInviteAccepted();

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
