import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import config from './index';
import User from '../models/User.model';

const jwtOptions = {
  secretOrKey: config.jwt.accessSecret,
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
};

const jwtVerify = async (payload: any, done: any) => {
  try {
    if (payload.type !== 'access') {
      throw new Error('Invalid token type');
    }
    const user = await User.findById(payload.sub);
    if (!user) {
      return done(null, false);
    }
    done(null, user);
  } catch (error) {
    done(error, false);
  }
};

const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);

export {
    jwtStrategy
};
