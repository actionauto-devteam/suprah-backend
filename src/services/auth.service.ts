import userService from './user.service';
import tokenService from './token.service';
import { ApiError } from '../utils/ApiError';
import Token from '../models/Token.model';

/**
 * Login with username and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<any>}
 */
const loginUserWithEmailAndPassword = async (email: string, password: string): Promise<any> => {
  const user = await userService.getUserByEmail(email);
  if (!user || !(await user.isPasswordMatch(password))) {
    throw new ApiError(401, 'Incorrect email or password');
  }
  return user;
};

/**
 * Logout
 * @param {string} refreshToken
 * @returns {Promise<void>}
 */
const logout = async (refreshToken: string): Promise<void> => {
  const refreshTokenDoc = await Token.findOne({ token: refreshToken, type: 'refresh', blacklisted: false });
  if (!refreshTokenDoc) {
    throw new ApiError(400, 'Refresh token not found or already invalidated');
  }
  await refreshTokenDoc.deleteOne();
};

/**
 * Refresh auth tokens
 * @param {string} refreshToken
 * @returns {Promise<any>}
 */
const refreshAuth = async (refreshToken: string): Promise<any> => {
  try {
    const refreshTokenDoc = await tokenService.verifyToken(refreshToken, 'refresh');
    const user = await userService.getUserById(refreshTokenDoc.user.toString());
    if (!user) {
      throw new Error();
    }
    await refreshTokenDoc.deleteOne();
    return tokenService.generateAuthTokens(user);
  } catch (error) {
    throw new ApiError(401, 'Please authenticate');
  }
};

export default {
  loginUserWithEmailAndPassword,
  logout,
  refreshAuth,
};
