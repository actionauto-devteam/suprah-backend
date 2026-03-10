import passport from 'passport';
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
        async (_req: any, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
            try {
                const email = profile.emails?.[0].value;
                if (!email) {
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
                        await user.save();
                    }
                    return done(null, user);
                }

                // Create new user if not found
                user = await User.create({
                    googleId: profile.id,
                    email: email.toLowerCase(),
                    name: profile.displayName,
                    avatar: profile.photos?.[0].value,
                    role: 'customer',
                    emailVerified: true,
                });

                done(null, user);
            } catch (error) {
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
