import crypto from 'crypto';
import userService from './user.service';
import tokenService from './token.service';
import { ApiError } from '../utils/ApiError';
import Token from '../models/Token.model';
import User from '../models/User.model';
import emailService from './email.service';
import config from '../config';

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
    if (error instanceof ApiError) {
      throw error;
    }
    console.error('Refresh Auth Failed:', error);
    throw new ApiError(401, 'Please authenticate');
  }
};

/**
 * Generate and send a password reset email.
 * @param {string} email
 * @returns {Promise<void>}
 */
const sendPasswordResetEmail = async (email: string): Promise<void> => {
    const user = await userService.getUserByEmail(email);
    if (!user) {
        // To prevent email enumeration, we don't throw an error.
        // The controller will send a generic success message.
        return;
    }

    // Generate a reset token
    const resetToken = crypto.randomBytes(32).toString('hex');

    // Hash the token and set expiry date (e.g., 10 minutes)
    user.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save({ validateBeforeSave: false }); // Skip full validation when only saving the token

    // Create reset URL (this should point to your frontend)
    const resetUrl = `${config.frontendUrl}/reset-password?token=${resetToken}`;

    const message = `You are receiving this email because you (or someone else) has requested the reset of a password for your account.\n\nPlease click on the following link, or paste this into your browser to complete the process:\n\n${resetUrl}\n\nIf you did not request this, please ignore this email and your password will remain unchanged.\n`;

    try {
        await emailService.sendEmail({
            to: user.email,
            subject: 'Password Reset Request',
            text: message,
        });
    } catch (err) {
        console.error('Error sending password reset email:', err);
        // Clear the token if email sending fails to allow user to try again
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });
        throw new ApiError(500, 'There was an error sending the email. Please try again later.');
    }
};

/**
 * Reset password with a valid token.
 * @param {string} token
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
const resetPassword = async (token: string, newPassword: string): Promise<void> => {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
        throw new ApiError(400, 'Password reset token is invalid or has expired');
    }

    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
};

export default {
  loginUserWithEmailAndPassword,
  logout,
  refreshAuth,
  sendPasswordResetEmail,
  resetPassword,
};
