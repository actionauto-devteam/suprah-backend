import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import Appointment from "../models/Appointment.model";
import AppointmentDashboardPost from "../models/AppointmentDashboardPost.model";
import Customer from "../models/Customer.model";
import CrmUser from "../models/CrmUser.model";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { IUser } from "../models/User.model";
import logger from "../utils/logger";

interface DashboardRange {
  start: Date;
  end: Date;
  isMonth: boolean;
  label: string;
}

// Service Hub is a Mountain Time business view. Keep the calendar-day/month
// interpretation anchored to America/Denver, then convert those boundaries to
// UTC for MongoDB. Using the IANA zone (rather than a fixed -6 offset) keeps
// both MDT and MST dates correct across daylight-saving transitions.
const DASHBOARD_TIME_ZONE = "America/Denver";

const dashboardTimePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const dashboardCalendarDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function calendarDateLabel(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseCalendarDate(value: string): {
  year: number;
  month: number;
  day: number;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));

  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function parseCalendarMonth(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;

  return { year, month };
}

/**
 * Resolve a Mountain Time wall-clock midnight to a UTC timestamp without a
 * fixed offset. Iterating against Intl's formatted wall clock makes this work
 * for both MDT (UTC-6) and MST (UTC-7), including DST boundary dates.
 */
function mountainMidnightUtcMs(year: number, month: number, day: number): number {
  const desiredWallClockAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = desiredWallClockAsUtc;

  for (let i = 0; i < 4; i += 1) {
    const parts = dashboardTimePartsFormatter.formatToParts(new Date(guess));
    const values: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") values[part.type] = part.value;
    }

    const representedWallClockAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
      0,
    );

    const correction = desiredWallClockAsUtc - representedWallClockAsUtc;
    if (correction === 0) break;
    guess += correction;
  }

  return guess;
}

function mountainCalendarDateFromInstant(value: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = dashboardCalendarDateFormatter.formatToParts(value);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function currentMountainCalendarDate(): { year: number; month: number; day: number } {
  return mountainCalendarDateFromInstant(new Date());
}

function dayRangeInMountainTime(year: number, month: number, day: number): DashboardRange {
  const startMs = mountainMidnightUtcMs(year, month, day);

  // Advance the calendar date in UTC only as a calendar arithmetic helper, then
  // independently resolve the next Mountain midnight. This preserves 23/25-hour
  // days around DST changes.
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day + 1));
  const nextStartMs = mountainMidnightUtcMs(
    nextCalendarDay.getUTCFullYear(),
    nextCalendarDay.getUTCMonth() + 1,
    nextCalendarDay.getUTCDate(),
  );

  return {
    start: new Date(startMs),
    end: new Date(nextStartMs - 1),
    isMonth: false,
    label: calendarDateLabel(year, month, day),
  };
}

function monthRangeInMountainTime(year: number, month: number): DashboardRange {
  const startMs = mountainMidnightUtcMs(year, month, 1);
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const nextStartMs = mountainMidnightUtcMs(
    nextMonth.getUTCFullYear(),
    nextMonth.getUTCMonth() + 1,
    1,
  );

  return {
    start: new Date(startMs),
    end: new Date(nextStartMs - 1),
    isMonth: true,
    label: `${year}-${pad2(month)}`,
  };
}

function resolveDashboardRange(query: any): DashboardRange {
  const isMonth = query.view === "month" || !!query.month;

  if (isMonth) {
    let monthStr = typeof query.month === "string" ? query.month.trim() : "";

    if (!monthStr && query.date) {
      const dateValue = String(query.date).trim();
      const plainDate = parseCalendarDate(dateValue);
      if (plainDate) {
        monthStr = `${plainDate.year}-${pad2(plainDate.month)}`;
      } else {
        const instant = new Date(dateValue);
        if (!Number.isNaN(instant.getTime())) {
          const mountainDate = mountainCalendarDateFromInstant(instant);
          monthStr = `${mountainDate.year}-${pad2(mountainDate.month)}`;
        }
      }
    }

    if (!monthStr) {
      const now = currentMountainCalendarDate();
      monthStr = `${now.year}-${pad2(now.month)}`;
    }

    const parsedMonth = parseCalendarMonth(monthStr);
    if (!parsedMonth) {
      throw new ApiError(400, "Invalid month format. Use YYYY-MM");
    }

    return monthRangeInMountainTime(parsedMonth.year, parsedMonth.month);
  }

  const dateRaw = query.date;
  if (!dateRaw) {
    throw new ApiError(
      400,
      "Date parameter is required (ISO string or YYYY-MM-DD)",
    );
  }

  const dateStr = String(dateRaw).trim();
  const plainDate = parseCalendarDate(dateStr);
  if (plainDate) {
    return dayRangeInMountainTime(plainDate.year, plainDate.month, plainDate.day);
  }

  // Backward compatibility: callers may still send a full ISO timestamp. Map
  // that instant to its Mountain Time calendar day, then query that whole day.
  const instant = new Date(dateStr);
  if (Number.isNaN(instant.getTime())) {
    throw new ApiError(
      400,
      "Invalid date format. Use ISO string or YYYY-MM-DD",
    );
  }

  const mountainDate = mountainCalendarDateFromInstant(instant);
  return dayRangeInMountainTime(
    mountainDate.year,
    mountainDate.month,
    mountainDate.day,
  );
}

/**
 * GET /api/appointments/dashboard
 * Fetch all booked appointments for a specific date or month (organization-wide)
 */
export const getAppointmentsDashboard = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const { status, type, skip = 0 } = req.query;

    // Resolve day OR month window.
    const range = resolveDashboardRange(req.query);

    // A whole month can hold far more than a single day, so allow a higher
    // default cap when in month view. Callers may still override with ?limit.
    const limit =
      req.query.limit !== undefined
        ? parseInt(req.query.limit as string) || 100
        : range.isMonth
          ? 1000
          : 100;

    // Build query
    const query: any = {
      organizationId: orgId,
      startTime: {
        $gte: range.start,
        $lte: range.end,
      },
      "customerBooking.isCustomerBooking": true, // Only customer bookings
    };

    // Apply optional filters
    if (status && status !== "all") {
      query.status = status;
    }

    if (type && type !== "all") {
      query.type = type;
    }

    // Fetch appointments with related data
    const appointments = await Appointment.find(query)
      .select(
        "title description startTime endTime type status customerBooking " +
          "createdBy source organizationId createdAt updatedAt entryType",
      )
      .populate({
        path: "createdBy",
        select: "fullName email username",
        model: "CrmUser",
      })
      .sort({ startTime: 1 })
      .limit(limit)
      .skip(parseInt(skip as string) || 0)
      .lean();

    // Enrich with additional data
    const enrichedAppointments = await Promise.all(
      appointments.map(async (apt: any) => {
        let customerData: any = null;
        let sourceInfo = apt.source || "Manual Booking";

        // Try to fetch customer by email if available
        if (apt.customerBooking?.email) {
          try {
            customerData = await Customer.findOne({
              organizationId: orgId,
              email: apt.customerBooking.email,
            })
              .select("firstName lastName email phone vehicleInterest source")
              .lean();
          } catch (err) {
            logger.warn(
              { customerId: apt.customerBooking.email },
              "Failed to fetch customer data",
            );
          }
        }

        // Determine appointment source
        if (customerData && customerData.source) {
          sourceInfo =
            customerData.source.charAt(0).toUpperCase() +
            customerData.source.slice(1);
        }

        return {
          _id: apt._id,
          title: apt.title,
          description: apt.description,
          startTime: apt.startTime,
          endTime: apt.endTime,
          type: apt.type || "in-person",
          status: apt.status || "scheduled",
          entryType: apt.entryType || "appointment",
          source: sourceInfo,
          customerBooking: {
            firstName:
              apt.customerBooking?.firstName ||
              customerData?.firstName ||
              "Unknown",
            lastName:
              apt.customerBooking?.lastName || customerData?.lastName || "",
            email: apt.customerBooking?.email,
            phone: apt.customerBooking?.phone || customerData?.phone || "N/A",
            isCustomerBooking: apt.customerBooking?.isCustomerBooking,
          },
          crmUser: {
            _id: apt.createdBy?._id,
            fullName: apt.createdBy?.fullName,
            email: apt.createdBy?.email,
            username: apt.createdBy?.username,
          },
          vehicleInterest: customerData?.vehicleInterest,
          createdAt: apt.createdAt,
          updatedAt: apt.updatedAt,
        };
      }),
    );

    // Get total count
    const total = await Appointment.countDocuments(query);

    res.json(
      new ApiResponse(
        200,
        {
          appointments: enrichedAppointments,
          total,
          date: range.label,
          view: range.isMonth ? "month" : "day",
          count: enrichedAppointments.length,
        },
        "Appointments dashboard fetched successfully",
      ),
    );
  },
);

/**
 * GET /api/appointments/dashboard/stats
 * Stat cards for the selected day OR month.
 */
export const getAppointmentsDashboardStats = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const range = resolveDashboardRange(req.query);

    const baseQuery = {
      organizationId: orgId,
      startTime: {
        $gte: range.start,
        $lte: range.end,
      },
      "customerBooking.isCustomerBooking": true,
    };

    const stats = {
      total: await Appointment.countDocuments(baseQuery),
      scheduled: await Appointment.countDocuments({
        ...baseQuery,
        status: "scheduled",
      }),
      confirmed: await Appointment.countDocuments({
        ...baseQuery,
        status: "confirmed",
      }),
      completed: await Appointment.countDocuments({
        ...baseQuery,
        status: "completed",
      }),
      cancelled: await Appointment.countDocuments({
        ...baseQuery,
        status: "cancelled",
      }),
      byType: {
        appointment: await Appointment.countDocuments({
          ...baseQuery,
          type: "appointment",
        }),
        event: await Appointment.countDocuments({
          ...baseQuery,
          type: "event",
        }),
        task: await Appointment.countDocuments({
          ...baseQuery,
          type: "task",
        }),
      },
    };

    res.json(new ApiResponse(200, stats, "Dashboard stats fetched"));
  },
);

/**
 * GET /api/appointments/dashboard/export
 * Export the selected day OR month as JSON or CSV.
 */
export const exportAppointmentsDashboard = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const { format = "json" } = req.query;

    const range = resolveDashboardRange(req.query);

    const query = {
      organizationId: orgId,
      startTime: {
        $gte: range.start,
        $lte: range.end,
      },
      "customerBooking.isCustomerBooking": true,
    };

    const appointments = await Appointment.find(query)
      .populate({
        path: "createdBy",
        select: "fullName email",
        model: "CrmUser",
      })
      .sort({ startTime: 1 })
      .lean();

    if (format === "csv") {
      // Generate CSV
      const headers = [
        "Customer Name",
        "Email",
        "Phone",
        "Appointment Date",
        "Appointment Time",
        "Duration",
        "Type",
        "Status",
        "CRM User",
        "Source",
      ];

      const rows = appointments.map((apt: any) => [
        `${apt.customerBooking?.firstName} ${apt.customerBooking?.lastName}`.trim(),
        apt.customerBooking?.email,
        apt.customerBooking?.phone,
        new Date(apt.startTime).toLocaleDateString("en-US", { timeZone: DASHBOARD_TIME_ZONE }),
        new Date(apt.startTime).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: DASHBOARD_TIME_ZONE,
        }),
        `${(new Date(apt.endTime).getTime() - new Date(apt.startTime).getTime()) / 60000} min`,
        apt.type || "appointment",
        apt.status || "scheduled",
        apt.createdBy?.fullName || "N/A",
        apt.source || "Manual",
      ]);

      const csv = [headers, ...rows]
        .map((row) => row.map((cell) => `"${cell}"`).join(","))
        .join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="appointments-${range.label}.csv"`,
      );
      res.send(csv);
    } else {
      res.json(
        new ApiResponse(
          200,
          { appointments, exportDate: range.label },
          "Export data ready",
        ),
      );
    }
  },
);

/**
 * GET /api/appointments/dashboard/posts
 * Fetch appointment dashboard posts (visible to all authenticated CRM users)
 *
 * NOTE: `createdBy` / `createdByModel` are now selected so the frontend can
 * show the delete control only on posts the current admin authored.
 */
export const getAppointmentDashboardPosts = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const { limit = 20 } = req.query;
    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 20));

    const posts = await AppointmentDashboardPost.find({ organizationId: orgId })
      .select(
        "type title content authorName authorRole createdBy createdByModel createdAt updatedAt",
      )
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .lean();

    res.json(
      new ApiResponse(
        200,
        { posts, count: posts.length },
        "Dashboard posts fetched successfully",
      ),
    );
  },
);

/**
 * POST /api/appointments/dashboard/posts
 * Create dashboard post (admin-only)
 */
export const createAppointmentDashboardPost = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const actor = req.crmUser;
    if (!actor) {
      throw new ApiError(401, "Not authenticated");
    }

    if (actor.role !== "admin") {
      throw new ApiError(403, "Only admins can create dashboard posts");
    }

    const { title, content, type = "event" } = req.body || {};

    const normalizedTitle = typeof title === "string" ? title.trim() : "";
    const normalizedContent = typeof content === "string" ? content.trim() : "";
    const normalizedType =
      typeof type === "string" ? type.trim().toLowerCase() : "event";

    const allowedTypes = ["event", "news", "announcement", "update"];

    if (!normalizedTitle) {
      throw new ApiError(400, "Title is required");
    }

    if (!normalizedContent) {
      throw new ApiError(400, "Content is required");
    }

    if (!allowedTypes.includes(normalizedType)) {
      throw new ApiError(400, "Invalid post type");
    }

    const post = await AppointmentDashboardPost.create({
      organizationId: orgId,
      type: normalizedType,
      title: normalizedTitle,
      content: normalizedContent,
      createdBy: actor._id,
      createdByModel: "CrmUser",
      authorName: actor.fullName || actor.username || actor.email,
      authorRole: actor.role,
    });

    res
      .status(201)
      .json(new ApiResponse(201, post, "Dashboard post created successfully"));
  },
);

/**
 * DELETE /api/appointments/dashboard/posts/:id
 * Delete a dashboard post.
 *
 * Authorization: an admin may delete a post they authored.
 *  - org isolation enforced via organizationId
 *  - ownership enforced via createdBy === actor._id
 */
export const deleteAppointmentDashboardPost = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const actor = req.crmUser;
    if (!actor) {
      throw new ApiError(401, "Not authenticated");
    }

    if (actor.role !== "admin") {
      throw new ApiError(403, "Only admins can delete dashboard posts");
    }

    const { id } = req.params;

    const post = await AppointmentDashboardPost.findOne({
      _id: id,
      organizationId: orgId,
    });

    if (!post) {
      throw new ApiError(404, "Post not found");
    }

    // Only the author may delete their own post.
    if (post.createdBy?.toString() !== actor._id.toString()) {
      throw new ApiError(403, "You can only delete your own posts");
    }

    await post.deleteOne();

    logger.info(
      { postId: id, userId: actor._id, orgId },
      "Dashboard post deleted",
    );

    res.json(new ApiResponse(200, { _id: id }, "Post deleted successfully"));
  },
);

export default {
  getAppointmentsDashboard,
  getAppointmentsDashboardStats,
  exportAppointmentsDashboard,
  getAppointmentDashboardPosts,
  createAppointmentDashboardPost,
  deleteAppointmentDashboardPost,
};