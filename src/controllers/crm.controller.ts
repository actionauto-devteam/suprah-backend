// repush
import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import CrmUser from "../models/CrmUser.model";
import TimeLog from "../models/TimeLog.model";
import {
  generateCrmToken,
  CRM_TOKEN_COOKIE,
} from "../middleware/crmAuth.middleware";
import emailService from "../services/email.service";
import { getSocketIO, emitToShiftBoard, emitToUser } from "../utils/socketEmitter";
import CrmPushService from "../services/crmPush.service";
import Absence from "../models/Absence.model";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 12 * 60 * 60 * 1000, // 12 hours
};

// Company operates on Mountain Daylight Time (MDT = UTC-6).
const COMPANY_TZ_OFFSET_MINUTES = -360;

/**
 * CRM Login
 * POST /api/crm/login
 */
const login = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    throw new ApiError(400, "Employee ID and password are required");
  }

  // Find user by username (Employee ID) - explicitly select password
  const user = await CrmUser.findOne({ username: username.trim() }).select(
    "+password",
  );

  if (!user) {
    throw new ApiError(401, "Invalid Employee ID or password");
  }

  if (!user.isActive) {
    throw new ApiError(
      403,
      "Account has been deactivated. Contact your administrator.",
    );
  }

  // Verify password
  const isMatch = await user.isPasswordMatch(password);

  if (!isMatch) {
    throw new ApiError(401, "Invalid Employee ID or password");
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

  res.json(new ApiResponse(200, { user: userData, token }, "Login successful"));
});

/**
 * CRM Logout
 * POST /api/crm/logout
 */
const logout = asyncHandler(async (req: Request, res: Response) => {
  res.clearCookie(CRM_TOKEN_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  res.json(new ApiResponse(200, null, "Logged out successfully"));
});

/**
 * Get current CRM user
 * GET /api/crm/me
 */
const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;

  if (!user) {
    throw new ApiError(401, "Not authenticated");
  }

  // Get today's time logs using MDT (UTC-6) day boundaries
  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  const today = new Date(todayMDTStartUTC);
  const tomorrow = new Date(todayMDTStartUTC + 24 * 60 * 60 * 1000);

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
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    todayTimeLogs: todayLogs,
  };

  res.json(new ApiResponse(200, userData, "User fetched successfully"));
});

/**
 * Time In / Time Out
 * POST /api/crm/time-clock
 */
const timeClock = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;

  if (!user) {
    throw new ApiError(401, "Not authenticated");
  }

  const { type, note } = req.body;

  const VALID_TYPES = ["time-in", "time-out", "break-in", "break-out"] as const;
  if (!type || !VALID_TYPES.includes(type)) {
    throw new ApiError(400, 'Type must be "time-in", "time-out", "break-in", or "break-out"');
  }

  // Use MDT (UTC-6) day boundaries so cross-UTC-midnight sessions are scoped correctly
  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  const today = new Date(todayMDTStartUTC);
  const tomorrow = new Date(todayMDTStartUTC + 24 * 60 * 60 * 1000);

  // Walk the last 2 days of logs chronologically. The 2-day window matches
  // getShiftState's lookback so a user with an unclosed clock-in from yesterday
  // (e.g. a forgotten clock-out) can still cleanly end the shift today. Walking
  // chronologically is orphan-safe — any stray events naturally cancel out and
  // the LAST event determines the actual active state.
  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - 2);
  lookbackStart.setHours(0, 0, 0, 0);

  const recentLogsForState = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: lookbackStart },
  }).sort({ timestamp: 1 }).lean();

  let hasActiveSession = false;
  let hasActiveBreak = false;
  for (const log of recentLogsForState) {
    if (log.type === 'time-in') { hasActiveSession = true; }
    else if (log.type === 'time-out') { hasActiveSession = false; hasActiveBreak = false; }
    else if (log.type === 'break-in') { hasActiveBreak = true; }
    else if (log.type === 'break-out') { hasActiveBreak = false; }
  }

  if (type === "time-in"   && hasActiveSession)  throw new ApiError(400, "You are already clocked in");
  if (type === "time-out"  && !hasActiveSession)  throw new ApiError(400, "You must clock in before clocking out");
  if (type === "time-out"  && hasActiveBreak)     throw new ApiError(400, "Please end your break before clocking out");
  if (type === "break-in"  && !hasActiveSession)  throw new ApiError(400, "You must be clocked in to start a break");
  if (type === "break-in"  && hasActiveBreak)     throw new ApiError(400, "You are already on break");
  if (type === "break-out" && !hasActiveBreak)    throw new ApiError(400, "No active break to end");

  const timeLog = await TimeLog.create({
    userId: user._id,
    type,
    timestamp: new Date(),
    note: note || undefined,
    ipAddress: req.ip || req.headers["x-forwarded-for"] || "unknown",
  });

  // Compute gross worked seconds for all completed sessions before this time-in
  let todayTotalWorkedSeconds = 0;
  if (type === 'time-in') {
    const prevLogs = await TimeLog.find({
      userId: user._id,
      type: { $in: ['time-in', 'time-out'] },
      timestamp: { $gte: today, $lt: timeLog.timestamp },
    }).sort({ timestamp: 1 }).lean();
    let sessionIn: Date | null = null;
    for (const log of prevLogs) {
      if (log.type === 'time-in') {
        sessionIn = new Date(log.timestamp);
      } else if (log.type === 'time-out' && sessionIn) {
        todayTotalWorkedSeconds += (new Date(log.timestamp).getTime() - sessionIn.getTime()) / 1000;
        sessionIn = null;
      }
    }
  }

  // Compute total completed break seconds for the CURRENT session on break-out events
  let totalBreakSeconds = 0;
  if (type === 'break-out') {
    // Find the latest time-in to scope breaks to the current session only
    const latestTimeIn = await TimeLog.findOne({
      userId: user._id,
      type: 'time-in',
      timestamp: { $gte: today, $lt: tomorrow },
    }).sort({ timestamp: -1 }).lean();

    const sessionStart = latestTimeIn?.timestamp ?? today;
    const breakLogs = await TimeLog.find({
      userId: user._id,
      type: { $in: ['break-in', 'break-out'] },
      timestamp: { $gte: sessionStart, $lt: tomorrow },
    }).sort({ timestamp: 1 }).lean();

    let currentBreakIn: Date | null = null;
    for (const log of breakLogs) {
      if (log.type === 'break-in') {
        currentBreakIn = new Date(log.timestamp);
      } else if (log.type === 'break-out' && currentBreakIn) {
        totalBreakSeconds += (new Date(log.timestamp).getTime() - currentBreakIn.getTime()) / 1000;
        currentBreakIn = null;
      }
    }
  }

  // Emit real-time event to tray app / CRM and to Live Shift Board
  try {
    const io = getSocketIO();
    const payload = {
      _id: timeLog._id,
      type: timeLog.type,
      timestamp: timeLog.timestamp,
      userId: user._id.toString(),
      ...(type === "time-in"   && { shiftStartedAt: timeLog.timestamp, todayTotalWorkedSeconds }),
      ...(type === "break-in"  && { breakStartedAt: timeLog.timestamp }),
      ...(type === "break-out" && { totalBreakSeconds }),
    };
    if (io) {
      io.to(`user:${user._id.toString()}`).emit(type, payload);
    }
    // Also notify the Live Shift Board so admins see instant updates
    emitToShiftBoard(type, payload);

    // When a user ends shift early with a reason, notify admins immediately
    if (type === 'time-out' && note) {
      const admins = await CrmUser.find({ role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
      const earlyEndPayload = { userId: user._id, fullName: user.fullName, reason: note, at: new Date() };
      for (const admin of admins) {
        emitToUser(admin._id.toString(), 'crm:early-end', earlyEndPayload);
      }
      emitToShiftBoard('crm:early-end', earlyEndPayload);
      // Push notification to all admin devices (desktop, mobile, tablet)
      CrmPushService.sendToAdmins({
        title: '🚪 Early End Shift',
        body: `${user.fullName} ended their shift early.\nReason: ${note}`,
        icon: '/icon-192x192.png',
        tag: `crm-early-end-${user._id}`,
        data: { url: '/crm/timeproof' },
      }).catch(() => {});

      // Mirror the early-out onto the Team Pulse calendar so HR can see all
      // out-of-office / early-out records in one place (per HR feedback).
      // Stored as a pending "other" absence so the HR team can review/approve.
      try {
        const existingAbsence = await Absence.findOne({
          organizationId: user.organizationId,
          userId: user._id,
          date: { $gte: today, $lt: tomorrow },
        });
        if (!existingAbsence) {
          await Absence.create({
            organizationId: user.organizationId,
            userId: user._id,
            userName: user.fullName,
            userAvatar: user.avatar,
            date: today,
            type: 'other',
            title: 'Early Out',
            note,
            otherText: 'Early Out',
            status: 'pending',
          });
        }
      } catch (absErr) {
        console.error('Failed to record early-out absence:', absErr);
      }
    }
  } catch (error) {
    console.error("Failed to emit time log event:", error);
  }

  // Return updated today's logs
  const todayLogs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: today, $lt: tomorrow },
  }).sort({ timestamp: -1 });

  const typeLabel: Record<string, string> = {
    "time-in": "Clocked in", "time-out": "Clocked out",
    "break-in": "Break started", "break-out": "Break ended",
  };

  res.status(201).json(
    new ApiResponse(201, { entry: timeLog, todayLogs }, `${typeLabel[type]} successfully`),
  );
});

/**
 * Get time logs for current user
 * GET /api/crm/time-logs
 */
const getTimeLogs = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;

  if (!user) {
    throw new ApiError(401, "Not authenticated");
  }

  const { startDate, endDate, limit = "30" } = req.query;

  const filter: any = { userId: user._id };

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) filter.timestamp.$gte = new Date(startDate as string);
    if (endDate) filter.timestamp.$lte = new Date(endDate as string);
  }

  const logs = await TimeLog.find(filter)
    .sort({ timestamp: -1 })
    .limit(parseInt(limit as string));

  res.json(
    new ApiResponse(200, { logs, total: logs.length }, "Time logs fetched"),
  );
});

/**
 * Generate the next available Employee ID for a given organization,
 * based on the current year and the highest existing sequence in that org.
 */
const resolveNextEmployeeId = async (
  organizationId: string | undefined,
): Promise<string> => {
  const year = new Date().getFullYear();

  // Always search globally — employee IDs must be unique across all organizations
  // so that login-by-username always resolves to exactly one user.
  const lastUser = await CrmUser.findOne(
    { username: new RegExp(`^${year}-`) },
    { username: 1 },
    { sort: { username: -1 } },
  );

  if (!lastUser) return `${year}-00001`;

  const seq = parseInt(lastUser.username.split("-")[1], 10);
  return `${year}-${String(seq + 1).padStart(5, "0")}`;
};

/**
 * Get next available Employee ID
 * GET /api/crm/next-employee-id
 */
const getNextEmployeeId = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor) {
    throw new ApiError(401, "Not authenticated");
  }

  if (!actor.organizationId) {
    throw new ApiError(
      403,
      "Your account is not linked to any organization. Contact your administrator.",
    );
  }

  const employeeId = await resolveNextEmployeeId(
    actor.organizationId?.toString(),
  );
  res.json(new ApiResponse(200, { employeeId }, "Next employee ID fetched"));
});

/**
 * Create a new CRM user
 * POST /api/crm/users
 * Admin only
 */
const createUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== "admin") {
    throw new ApiError(403, "Only admins can create CRM users");
  }

  if (!actor.organizationId) {
    throw new ApiError(
      403,
      "Your account is not linked to any organization. Contact your administrator.",
    );
  }

  const { fullName, email, password, role, birthday, hireDate, gender } = req.body;

  if (!fullName?.trim() || !email?.trim() || !password || !role) {
    throw new ApiError(400, "fullName, email, password, and role are required");
  }

  const emailTaken = await CrmUser.findOne({
    email: email.trim().toLowerCase(),
  });
  if (emailTaken) {
    throw new ApiError(409, "An account with that email already exists");
  }

  const employeeId = await resolveNextEmployeeId(
    actor.organizationId?.toString(),
  );

  const user = await CrmUser.create({
    organizationId: actor.organizationId,
    fullName: fullName.trim(),
    username: employeeId,
    email: email.trim().toLowerCase(),
    password,
    role,
    isActive: true,
    birthday: birthday ? new Date(birthday) : undefined,
    hireDate: hireDate ? new Date(hireDate) : undefined,
    gender: gender && ['male', 'female'].includes(gender) ? gender : undefined,
  });

  res.status(201).json(
    new ApiResponse(
      201,
      {
        _id: user._id,
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
      },
      "User created successfully",
    ),
  );
});

/**
 * Get all CRM users
 * GET /api/crm/users
 * Admin only
 */
const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor) {
    throw new ApiError(401, "Authentication required");
  }

  if (!actor.organizationId) {
    throw new ApiError(
      403,
      "Your account is not linked to any organization. Contact your administrator.",
    );
  }

  const {
    page = '1',
    limit = '10',
    search,
    role,
    status,
    dateJoined,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;

  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = { organizationId: actor.organizationId };

  const searchValue = typeof search === 'string' ? search.trim() : '';
  if (searchValue) {
    const escapedSearch = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { fullName: { $regex: escapedSearch, $options: 'i' } },
      { email: { $regex: escapedSearch, $options: 'i' } },
      { username: { $regex: escapedSearch, $options: 'i' } },
    ];
  }

  const roleValue = typeof role === 'string' ? role.toLowerCase() : '';
  if (['employee', 'manager', 'admin'].includes(roleValue)) {
    filter.role = roleValue;
  }

  const statusValue = typeof status === 'string' ? status.toLowerCase() : '';
  if (statusValue === 'active') {
    filter.isActive = true;
  } else if (statusValue === 'inactive') {
    filter.isActive = false;
  }

  const dateJoinedValue = typeof dateJoined === 'string' ? dateJoined.toLowerCase() : '';
  if (dateJoinedValue && dateJoinedValue !== 'all') {
    const now = new Date();
    let startDate: Date | null = null;

    if (dateJoinedValue === '7d') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
    } else if (dateJoinedValue === '30d') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
    } else if (dateJoinedValue === '90d') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 90);
    } else if (dateJoinedValue === 'year') {
      startDate = new Date(now.getFullYear(), 0, 1);
    }

    if (startDate) {
      filter.createdAt = { ...(filter.createdAt || {}), $gte: startDate };
    }
  }

  const sortFieldMap: Record<string, string> = {
    fullName: 'fullName',
    username: 'username',
    email: 'email',
    role: 'role',
    status: 'isActive',
    isActive: 'isActive',
    createdAt: 'createdAt',
    joined: 'createdAt',
    lastLoginAt: 'lastLoginAt',
    hireDate: 'hireDate',
    birthday: 'birthday',
  };

  const resolvedSortBy =
    typeof sortBy === 'string' && sortFieldMap[sortBy]
      ? sortFieldMap[sortBy]
      : 'createdAt';
  const resolvedSortOrder = sortOrder === 'asc' ? 1 : -1;

  const sortQuery: Record<string, 1 | -1> = {
    [resolvedSortBy]: resolvedSortOrder,
  };

  if (resolvedSortBy !== 'createdAt') {
    sortQuery.createdAt = -1;
  }

  const [users, total] = await Promise.all([
    CrmUser.find(filter)
      .select('fullName username email avatar role isActive lastLoginAt createdAt birthday hireDate gender isOffboarded offboardedAt')
      .sort(sortQuery)
      .skip(skip)
      .limit(limitNum),
    CrmUser.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  res.json(
    new ApiResponse(
      200,
      {
        users,
        total,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
        },
      },
      'Users fetched successfully',
    ),
  );
});

/**
 * Update a CRM user (fullName, email, role)
 * PATCH /api/crm/users/:id
 * Admin only
 */
const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== "admin") {
    throw new ApiError(403, "Only admins can edit CRM users");
  }

  const { id } = req.params;
  const { fullName, email, role, birthday, hireDate, gender } = req.body;

  const user = await CrmUser.findOne({
    _id: id,
    organizationId: actor.organizationId,
  });
  if (!user) throw new ApiError(404, "User not found");

  if (fullName?.trim()) user.fullName = fullName.trim();

  if (email?.trim()) {
    const emailTaken = await CrmUser.findOne({
      email: email.trim().toLowerCase(),
      _id: { $ne: id },
    });
    if (emailTaken)
      throw new ApiError(409, "An account with that email already exists");
    user.email = email.trim().toLowerCase();
  }

  if (role && ["employee", "manager", "admin"].includes(role)) {
    user.role = role;
  }

  if (birthday !== undefined) {
    user.birthday = birthday ? new Date(birthday) : undefined;
    user.markModified("birthday");
  }

  if (hireDate !== undefined) {
    user.hireDate = hireDate ? new Date(hireDate) : undefined;
    user.markModified("hireDate");
  }

  if (gender !== undefined) {
    user.gender = gender && ['male', 'female'].includes(gender) ? gender : undefined;
  }

  await user.save({ validateModifiedOnly: true });

  res.json(
    new ApiResponse(
      200,
      {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
      "User updated successfully",
    ),
  );
});

/**
 * Toggle active / inactive status of a CRM user
 * PATCH /api/crm/users/:id/status
 * Admin only
 */
const toggleUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== "admin") {
    throw new ApiError(403, "Only admins can change user status");
  }

  const { id } = req.params;

  if (id === actor._id.toString()) {
    throw new ApiError(400, "You cannot deactivate your own account");
  }

  const user = await CrmUser.findOne({
    _id: id,
    organizationId: actor.organizationId,
  });
  if (!user) throw new ApiError(404, "User not found");

  user.isActive = !user.isActive;
  await user.save({ validateModifiedOnly: true });

  res.json(
    new ApiResponse(
      200,
      { isActive: user.isActive },
      `User ${user.isActive ? "reactivated" : "deactivated"} successfully`,
    ),
  );
});

/**
 * Delete a CRM user
 * DELETE /api/crm/users/:id
 * Admin only
 */
const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== "admin") {
    throw new ApiError(403, "Only admins can delete CRM users");
  }

  const { id } = req.params;

  if (id === actor._id.toString()) {
    throw new ApiError(400, "You cannot delete your own account");
  }

  const user = await CrmUser.findOneAndDelete({
    _id: id,
    organizationId: actor.organizationId,
  });
  if (!user) throw new ApiError(404, "User not found");

  res.json(new ApiResponse(200, null, "User deleted successfully"));
});

/**
 * Forgot Password — send OTP to email
 * POST /api/crm/forgot-password (public)
 */
const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email?.trim()) {
    throw new ApiError(400, "Email is required");
  }

  const user = await CrmUser.findOne({
    email: email.trim().toLowerCase(),
  }).select("+resetOtp +resetOtpExpiry");

  // Always return 200 to prevent email enumeration
  if (!user) {
    return res.json(
      new ApiResponse(
        200,
        null,
        "If that email exists, a reset code has been sent.",
      ),
    );
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  user.resetOtp = otp;
  user.resetOtpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  await user.save({ validateModifiedOnly: true });

  await emailService.sendCrmPasswordResetEmail(user.email, user.fullName, otp);

  res.json(
    new ApiResponse(
      200,
      null,
      "If that email exists, a reset code has been sent.",
    ),
  );
});

/**
 * Confirm Password Reset — verify OTP and set new password
 * POST /api/crm/reset-password (public)
 */
const confirmResetPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { email, otp, newPassword } = req.body;

    if (!email?.trim() || !otp?.trim() || !newPassword) {
      throw new ApiError(400, "Email, OTP, and new password are required");
    }

    if (newPassword.length < 8) {
      throw new ApiError(400, "Password must be at least 8 characters");
    }

    const user = await CrmUser.findOne({
      email: email.trim().toLowerCase(),
    }).select("+resetOtp +resetOtpExpiry +password");

    if (!user || !user.resetOtp || !user.resetOtpExpiry) {
      throw new ApiError(400, "Invalid or expired reset code");
    }

    if (new Date() > user.resetOtpExpiry) {
      throw new ApiError(
        400,
        "Reset code has expired. Please request a new one.",
      );
    }

    if (user.resetOtp !== otp.trim()) {
      throw new ApiError(400, "Invalid reset code");
    }

    user.password = newPassword;
    user.resetOtp = undefined;
    user.resetOtpExpiry = undefined;
    await user.save({ validateModifiedOnly: true });

    res.json(new ApiResponse(200, null, "Password reset successfully"));
  },
);

/**
 * Reset a CRM user's password (admin only)
 * PATCH /api/crm/users/:id/reset-password
 */
const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== "admin") {
    throw new ApiError(403, "Only admins can reset user passwords");
  }

  const { id } = req.params;
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters");
  }

  if (id === actor._id.toString()) {
    throw new ApiError(
      400,
      "Use the change password feature to update your own password",
    );
  }

  const user = await CrmUser.findOne({
    _id: id,
    organizationId: actor.organizationId,
  }).select("+password");
  if (!user) throw new ApiError(404, "User not found");

  user.password = newPassword;
  await user.save({ validateModifiedOnly: true });

  res.json(new ApiResponse(200, null, "Password reset successfully"));
});

/**
 * Offboard a CRM user (soft-deactivate, preserve records)
 * POST /api/crm/users/:id/offboard
 * Admin only
 */
const offboardUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor || actor.role !== "admin") {
    throw new ApiError(403, "Only admins can offboard users");
  }

  const { id } = req.params;

  if (id === actor._id.toString()) {
    throw new ApiError(400, "You cannot offboard your own account");
  }

  const user = await CrmUser.findOne({
    _id: id,
    organizationId: actor.organizationId,
  });
  if (!user) throw new ApiError(404, "User not found");

  if (user.isOffboarded) {
    throw new ApiError(409, "User is already offboarded");
  }

  user.isActive = false;
  user.isOffboarded = true;
  user.offboardedAt = new Date();
  await user.save({ validateModifiedOnly: true });

  res.json(new ApiResponse(200, null, "User offboarded successfully"));
});

/**
 * POST /api/crm/token-refresh
 * Renews the CRM JWT token. Requires a valid (not yet expired) token.
 * Tray app calls this on startup and whenever it receives a 401.
 */
const tokenRefresh = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const newToken = generateCrmToken(user._id.toString());
  res.cookie(CRM_TOKEN_COOKIE, newToken, COOKIE_OPTIONS);
  res.json(new ApiResponse(200, { token: newToken }, "Token refreshed"));
});

export default {
  login,
  logout,
  forgotPassword,
  confirmResetPassword,
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
  offboardUser,
  tokenRefresh,
};
