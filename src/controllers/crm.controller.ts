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

export default {
  login,
  logout,
  getMe,
  timeClock,
  getTimeLogs,
};