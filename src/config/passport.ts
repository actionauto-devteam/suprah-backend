import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import config from './index';
import User from '../models/User.model';
import DriverRequest from '../models/DriverRequest.model';
import notificationService from '../services/notification.service';

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
                    if (!user.googleId) {
                        user.googleId = profile.id;
                    }

                    // If it's an existing user who "migrated" but never picked a role beyond the default customer
                    // we might want to flag them for onboarding if we just added this field.
                    // Check if onboardingCompleted is explicitly true or not.
                    if (user.onboardingCompleted === undefined || user.onboardingCompleted === null) {
                        // For legacy users, if they are already not just a default customer, they are done.
                        // If they ARE a customer, let them re-verify their role via onboarding.
                        if (user.role === 'customer') {
                            user.onboardingCompleted = false;
                        } else {
                            user.onboardingCompleted = true;
                        }
                    }

                    await user.save();
                    return done(null, user);
                }

                // Extract requested role from state
                let requestedRole: string | undefined;
                try {
                    if (req.query.state) {
                        const state = JSON.parse(req.query.state as string);
                        requestedRole = state.role;
                    }
                } catch (e) {
                    console.error('Passport Google Strategy: Failed to parse state', e);
                }

                // If user picked a role on Sign-Up, onboarding is completed.
                // If they came from Sign-In without a role, it's not completed.
                const onboardingCompleted = !!requestedRole;
                const roleToAssign = requestedRole === 'dealership' ? 'admin' : (requestedRole || 'customer');

                // Create new user if not found
                user = await User.create({
                    googleId: profile.id,
                    email: email.toLowerCase(),
                    name: profile.displayName || email.split('@')[0], // Fallback if name is missing
                    avatar: profile.photos?.[0].value,
                    role: roleToAssign,
                    emailVerified: true,
                    onboardingCompleted,
                });

                // If specialized as a driver, create an approval request immediately
                if (roleToAssign === 'driver') {
                    try {
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
                                title: 'New Driver Request (Google)',
                                message: `${user.name} (${user.email}) has signed up via Google as a driver and needs approval.`,
                                metadata: {
                                    driverRequestId: driverRequest._id.toString(),
                                    driverName: user.name,
                                    driverEmail: user.email
                                }
                            }).catch(err => console.error('[Passport] Notification failed:', err));
                        }
                    } catch (err) {
                        console.error('[Passport] Failed to create driver request:', err);
                    }
                }

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
