import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';
import { generateCrmToken, CRM_TOKEN_COOKIE } from '../middleware/crmAuth.middleware';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 12 * 60 * 60 * 1000, // 12 hours
};

/**
 * CRM Login
 * POST /api/crm/login
 */
const login = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    throw new ApiError(400, 'Employee ID and password are required');
  }

  // Find user by username (Employee ID) - explicitly select password
  const user = await CrmUser.findOne({ username: username.trim() }).select('+password');

  if (!user) {
    throw new ApiError(401, 'Invalid Employee ID or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Account has been deactivated. Contact your administrator.');
  }

  // Verify password
  const isMatch = await user.isPasswordMatch(password);

  if (!isMatch) {
    throw new ApiError(401, 'Invalid Employee ID or password');
  }

  // Update last login
  user.lastLoginAt = new Date();
  await user.save({ validateModifiedOnly: true });

  // Generate token
  const token = generateCrmToken(user._id.toString());

  // Set httpOnly cookie
  res.cookie(CRM_TOKEN_COOKIE, token, COOKIE_OPTIONS);

  // Return user data (without password)
  const userData = {
    _id: user._id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    role: user.role,
  };

  res.json(
    new ApiResponse(200, { user: userData, token }, 'Login successful')
  );
});

/**
 * CRM Logout
 * POST /api/crm/logout
 */
const logout = asyncHandler(async (req: Request, res: Response) => {
  res.clearCookie(CRM_TOKEN_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  res.json(new ApiResponse(200, null, 'Logged out successfully'));
});

/**
 * Get current CRM user
 * GET /api/crm/me
 */
const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;

  if (!user) {
    throw new ApiError(401, 'Not authenticated');
  }

  // Get today's time logs
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayLogs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: today, $lt: tomorrow },
  }).sort({ timestamp: -1 });

  const userData = {
    _id: user._id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
    todayTimeLogs: todayLogs,
  };

  res.json(new ApiResponse(200, userData, 'User fetched successfully'));
});

/**
 * Time In / Time Out
 * POST /api/crm/time-clock
 */
const timeClock = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;

  if (!user) {
    throw new ApiError(401, 'Not authenticated');
  }

  const { type, note } = req.body;

  if (!type || !['time-in', 'time-out'].includes(type)) {
    throw new ApiError(400, 'Type must be "time-in" or "time-out"');
  }

  // Check for duplicate time-in today (prevent double clock-in)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (type === 'time-in') {
    const existingTimeIn = await TimeLog.findOne({
      userId: user._id,
      type: 'time-in',
      timestamp: { $gte: today, $lt: tomorrow },
    });

    if (existingTimeIn) {
      throw new ApiError(400, 'You have already clocked in today');
    }
  }

  if (type === 'time-out') {
    const existingTimeIn = await TimeLog.findOne({
      userId: user._id,
      type: 'time-in',
      timestamp: { $gte: today, $lt: tomorrow },
    });

    if (!existingTimeIn) {
      throw new ApiError(400, 'You must clock in before clocking out');
    }

    const existingTimeOut = await TimeLog.findOne({
      userId: user._id,
      type: 'time-out',
      timestamp: { $gte: today, $lt: tomorrow },
    });

    if (existingTimeOut) {
      throw new ApiError(400, 'You have already clocked out today');
    }
  }

  const timeLog = await TimeLog.create({
    userId: user._id,
    type,
    timestamp: new Date(),
    note: note || undefined,
    ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
  });

  // Return updated today's logs
  const todayLogs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: today, $lt: tomorrow },
  }).sort({ timestamp: -1 });

  res.status(201).json(
    new ApiResponse(201, { entry: timeLog, todayLogs }, `${type === 'time-in' ? 'Clocked in' : 'Clocked out'} successfully`)
  );
});

/**
 * Get time logs for current user
 * GET /api/crm/time-logs
 */
const getTimeLogs = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;

  if (!user) {
    throw new ApiError(401, 'Not authenticated');
  }

  const { startDate, endDate, limit = '30' } = req.query;

  const filter: any = { userId: user._id };

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) filter.timestamp.$gte = new Date(startDate as string);
    if (endDate) filter.timestamp.$lte = new Date(endDate as string);
  }

  const logs = await TimeLog.find(filter)
    .sort({ timestamp: -1 })
    .limit(parseInt(limit as string));

  res.json(new ApiResponse(200, { logs, total: logs.length }, 'Time logs fetched'));
});

/**
 * Generate the next available Employee ID for a given organization,
 * based on the current year and the highest existing sequence in that org.
 */
const resolveNextEmployeeId = async (organizationId: string | undefined): Promise<string> => {
  const year = new Date().getFullYear();

  // Always search globally — employee IDs must be unique across all organizations
  // so that login-by-username always resolves to exactly one user.
  const lastUser = await CrmUser.findOne(
    { username: new RegExp(`^${year}-`) },
    { username: 1 },
    { sort: { username: -1 } }
  );

  if (!lastUser) return `${year}-00001`;

  const seq = parseInt(lastUser.username.split('-')[1], 10);
  return `${year}-${String(seq + 1).padStart(5, '0')}`;
};

/**
 * Get next available Employee ID
 * GET /api/crm/next-employee-id
 */
const getNextEmployeeId = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor) {
    throw new ApiError(401, 'Not authenticated');
  }

  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization. Contact your administrator.');
  }

  const employeeId = await resolveNextEmployeeId(actor.organizationId?.toString());
  res.json(new ApiResponse(200, { employeeId }, 'Next employee ID fetched'));
});

/**
 * Create a new CRM user
 * POST /api/crm/users
 * Admin only
 */
const createUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can create CRM users');
  }

  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization. Contact your administrator.');
  }

  const { fullName, email, password, role } = req.body;

  if (!fullName?.trim() || !email?.trim() || !password || !role) {
    throw new ApiError(400, 'fullName, email, password, and role are required');
  }

  const emailTaken = await CrmUser.findOne({ email: email.trim().toLowerCase() });
  if (emailTaken) {
    throw new ApiError(409, 'An account with that email already exists');
  }

  const employeeId = await resolveNextEmployeeId(actor.organizationId?.toString());

  const user = await CrmUser.create({
    organizationId: actor.organizationId,
    fullName: fullName.trim(),
    username: employeeId,
    email: email.trim().toLowerCase(),
    password,
    role,
    isActive: true,
  });

  res.status(201).json(
    new ApiResponse(201, {
      _id: user._id,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    }, 'User created successfully')
  );
});

/**
 * Get all CRM users
 * GET /api/crm/users
 * Admin only
 */
const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can view CRM users');
  }

  if (!actor.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization. Contact your administrator.');
  }

  const users = await CrmUser.find({ organizationId: actor.organizationId })
    .select('fullName username email role isActive lastLoginAt createdAt')
    .sort({ createdAt: -1 });

  res.json(new ApiResponse(200, { users, total: users.length }, 'Users fetched successfully'));
});

/**
 * Update a CRM user (fullName, email, role)
 * PATCH /api/crm/users/:id
 * Admin only
 */
const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can edit CRM users');
  }

  const { id } = req.params;
  const { fullName, email, role } = req.body;

  const user = await CrmUser.findOne({ _id: id, organizationId: actor.organizationId });
  if (!user) throw new ApiError(404, 'User not found');

  if (fullName?.trim()) user.fullName = fullName.trim();

  if (email?.trim()) {
    const emailTaken = await CrmUser.findOne({
      email: email.trim().toLowerCase(),
      _id: { $ne: id },
    });
    if (emailTaken) throw new ApiError(409, 'An account with that email already exists');
    user.email = email.trim().toLowerCase();
  }

  if (role && ['employee', 'manager', 'admin'].includes(role)) {
    user.role = role;
  }

  await user.save({ validateModifiedOnly: true });

  res.json(
    new ApiResponse(200, {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    }, 'User updated successfully')
  );
});

/**
 * Toggle active / inactive status of a CRM user
 * PATCH /api/crm/users/:id/status
 * Admin only
 */
const toggleUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can change user status');
  }

  const { id } = req.params;

  if (id === actor._id.toString()) {
    throw new ApiError(400, 'You cannot deactivate your own account');
  }

  const user = await CrmUser.findOne({ _id: id, organizationId: actor.organizationId });
  if (!user) throw new ApiError(404, 'User not found');

  user.isActive = !user.isActive;
  await user.save({ validateModifiedOnly: true });

  res.json(
    new ApiResponse(
      200,
      { isActive: user.isActive },
      `User ${user.isActive ? 'reactivated' : 'deactivated'} successfully`
    )
  );
});

/**
 * Delete a CRM user
 * DELETE /api/crm/users/:id
 * Admin only
 */
const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can delete CRM users');
  }

  const { id } = req.params;

  if (id === actor._id.toString()) {
    throw new ApiError(400, 'You cannot delete your own account');
  }

  const user = await CrmUser.findOneAndDelete({ _id: id, organizationId: actor.organizationId });
  if (!user) throw new ApiError(404, 'User not found');

  res.json(new ApiResponse(200, null, 'User deleted successfully'));
});

/**
 * Reset a CRM user's password (admin only)
 * PATCH /api/crm/users/:id/reset-password
 */
const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can reset user passwords');
  }

  const { id } = req.params;
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters');
  }

  if (id === actor._id.toString()) {
    throw new ApiError(400, 'Use the change password feature to update your own password');
  }

  const user = await CrmUser.findOne({ _id: id, organizationId: actor.organizationId }).select('+password');
  if (!user) throw new ApiError(404, 'User not found');

  user.password = newPassword;
  await user.save({ validateModifiedOnly: true });

  res.json(new ApiResponse(200, null, 'Password reset successfully'));
});

export default {
  login,
  logout,
  getMe,
  timeClock,
  getTimeLogs,
  getNextEmployeeId,
  createUser,
  getUsers,
  updateUser,
  toggleUserStatus,
  deleteUser,
  resetPassword,
};