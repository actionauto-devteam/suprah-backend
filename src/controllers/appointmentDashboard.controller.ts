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

/**
 * Resolve the dashboard query window from the request query.
 *
 *  - view=month&month=YYYY-MM  -> full calendar month (UTC)
 *  - date=YYYY-MM-DD | ISO     -> single day (UTC, existing behaviour)
 *
 * The frontend sends `date` in every request for backward compatibility, and
 * additionally sends `view=month&month=YYYY-MM` when the "entire month" filter
 * is active. Ranges are computed in UTC to match the original single-day logic.
 */
interface DashboardRange {
  start: Date;
  end: Date;
  isMonth: boolean;
  /** YYYY-MM for a month, YYYY-MM-DD for a single day. */
  label: string;
}

function resolveDashboardRange(query: any): DashboardRange {
  const isMonth = query.view === "month" || !!query.month;

  if (isMonth) {
    // Prefer explicit month=YYYY-MM, else derive from date=YYYY-MM-DD, else now.
    const monthStr: string =
      (query.month as string) ||
      (query.date ? String(query.date).slice(0, 7) : "") ||
      new Date().toISOString().slice(0, 7);

    const [y, m] = monthStr.split("-").map((n: string) => parseInt(n, 10));

    if (!y || !m || m < 1 || m > 12) {
      throw new ApiError(400, "Invalid month format. Use YYYY-MM");
    }

    // First instant of the month .. last instant of the month (UTC).
    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)); // day 0 = last day of prev month

    return { start, end, isMonth: true, label: monthStr };
  }

  // Single-day window (unchanged from the original implementation).
  const dateRaw = query.date;
  if (!dateRaw) {
    throw new ApiError(
      400,
      "Date parameter is required (ISO string or YYYY-MM-DD)",
    );
  }

  let dateObj: Date;
  try {
    const dateStr = String(dateRaw).trim();
    dateObj = dateStr.includes("T")
      ? new Date(dateStr)
      : new Date(`${dateStr}T00:00:00Z`);

    if (isNaN(dateObj.getTime())) {
      throw new Error("Invalid date");
    }
  } catch (err) {
    throw new ApiError(
      400,
      "Invalid date format. Use ISO string or YYYY-MM-DD",
    );
  }

  const start = new Date(dateObj);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(dateObj);
  end.setUTCHours(23, 59, 59, 999);

  return {
    start,
    end,
    isMonth: false,
    label: dateObj.toISOString().split("T")[0],
  };
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
        new Date(apt.startTime).toLocaleDateString("en-US"),
        new Date(apt.startTime).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
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