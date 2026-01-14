import User, { IUser } from '../models/User.model';
import { ApiError } from '../utils/ApiError';

/**
 * Create a user
 * @param {Partial<IUser>} userBody
 * @returns {Promise<IUser>}
 */
const createUser = async (userBody: Partial<IUser>): Promise<IUser> => {
  if (await User.isEmailTaken(userBody.email!)) {
    throw new ApiError(400, 'Email already taken');
  }
  return User.create(userBody);
};

/**
 * Get user by email
 * @param {string} email
 * @returns {Promise<IUser | null>}
 */
const getUserByEmail = async (email: string): Promise<IUser | null> => {
  return User.findOne({ email });
};

/**
 * Get user by id
 * @param {string} id
 * @returns {Promise<IUser | null>}
 */
const getUserById = async (id: string): Promise<IUser | null> => {
    return User.findById(id);
};


export default {
  createUser,
  getUserByEmail,
  getUserById
};
