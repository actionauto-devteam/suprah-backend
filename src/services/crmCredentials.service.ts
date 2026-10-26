import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';

export async function verifyCrmCredentials(username: unknown, password: unknown) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new ApiError(400, 'Employee ID and password are required');
  }

  const user = await CrmUser.findOne({ username: username.trim() }).select('+password');

  if (!user) {
    throw new ApiError(401, 'Invalid Employee ID or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Account has been deactivated. Contact your administrator.');
  }

  const isMatch = await user.isPasswordMatch(password);

  if (!isMatch) {
    throw new ApiError(401, 'Invalid Employee ID or password');
  }

  return user;
}
