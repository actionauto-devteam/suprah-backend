import jwt from 'jsonwebtoken';
import moment from 'moment';
import config from '../config';
import Token, { IToken } from '../models/Token.model';
import { IUser } from '../models/User.model';
import { ApiError } from '../utils/ApiError';

/**
 * Generate token
 * @param {IUser} user
 * @param {moment.Moment} expires
 * @param {string} type
 * @param {string} secret
 * @returns {string}
 */
const generateToken = (user: IUser, expires: moment.Moment, type: string, secret: string = config.jwt.accessSecret): string => {
  const payload = {
    sub: user.id,
    iat: moment().unix(),
    exp: expires.unix(),
    type,
  };
  return jwt.sign(payload, secret);
};

/**
 * Save a token
 * @param {string} token
 * @param {IUser} user
 * @param {moment.Moment} expires
 * @param {string} type
 * @param {boolean} [blacklisted=false]
 * @returns {Promise<IToken>}
 */
const saveToken = async (
  token: string,
  user: IUser,
  expires: moment.Moment,
  type: string,
  blacklisted: boolean = false
): Promise<IToken> => {
  const tokenDoc = await Token.create({
    token,
    user: user.id,
    expires: expires.toDate(),
    type,
    blacklisted,
  });
  return tokenDoc;
};

/**
 * Verify token and return token doc (or throw an error if it is not valid)
 * @param {string} token
 * @param {string} type
 * @returns {Promise<IToken>}
 */
const verifyToken = async (token: string, type: string): Promise<IToken> => {
  const payload = jwt.verify(token, type === 'refresh' ? config.jwt.refreshSecret : config.jwt.accessSecret);
  if (typeof payload.sub !== 'string') {
    throw new ApiError(401, 'Invalid token');
  }
  const tokenDoc = await Token.findOne({ token, type, user: payload.sub, blacklisted: false });
  if (!tokenDoc) {
    throw new ApiError(401, 'Token not found');
  }
  return tokenDoc;
};

/**
 * Generate auth tokens
 * @param {IUser} user
 * @returns {Promise<Object>}
 */
const generateAuthTokens = async (user: IUser) => {
  const accessTokenExpires = moment().add(config.jwt.accessExpiration, 'minutes');
  const accessToken = generateToken(user, accessTokenExpires, 'access');

  const refreshTokenExpires = moment().add(config.jwt.refreshExpiration, 'days');
  const refreshToken = generateToken(user, refreshTokenExpires, 'refresh', config.jwt.refreshSecret);
  await saveToken(refreshToken, user, refreshTokenExpires, 'refresh');

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate(),
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate(),
    },
  };
};

export default {
  generateToken,
  saveToken,
  verifyToken,
  generateAuthTokens,
};
