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
 * GET /api/appointments/dashboard
 * Fetch all booked appointments for a specific date (organization-wide)
 */
export const getAppointmentsDashboard = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const { date, status, type, limit = 100, skip = 0 } = req.query;

    if (!date) {
      throw new ApiError(
        400,
        "Date parameter is required (ISO string or YYYY-MM-DD)",
      );
    }

    // Parse the date (handle both ISO string and YYYY-MM-DD format)
    let dateObj: Date;
    try {
      const dateStr = (date as string).trim();
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

    // Create date range for the entire day (UTC)
    const startOfDay = new Date(dateObj);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date(dateObj);
    endOfDay.setUTCHours(23, 59, 59, 999);

    // Build query
    const query: any = {
      organizationId: orgId,
      startTime: {
        $gte: startOfDay,
        $lte: endOfDay,
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
      .limit(parseInt(limit as string) || 100)
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
          date: dateObj.toISOString().split("T")[0],
          count: enrichedAppointments.length,
        },
        "Appointments dashboard fetched successfully",
      ),
    );
  },
);

/**
 * GET /api/appointments/dashboard/stats
 */
export const getAppointmentsDashboardStats = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const { date } = req.query;

    if (!date) {
      throw new ApiError(400, "Date parameter is required");
    }

    let dateObj: Date;
    try {
      const dateStr = (date as string).trim();
      dateObj = dateStr.includes("T")
        ? new Date(dateStr)
        : new Date(`${dateStr}T00:00:00Z`);

      if (isNaN(dateObj.getTime())) {
        throw new Error("Invalid date");
      }
    } catch (err) {
      throw new ApiError(400, "Invalid date format");
    }

    const startOfDay = new Date(dateObj);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date(dateObj);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const baseQuery = {
      organizationId: orgId,
      startTime: {
        $gte: startOfDay,
        $lte: endOfDay,
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
 */
export const exportAppointmentsDashboard = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    if (!orgId) {
      throw new ApiError(400, "Organization context missing");
    }

    const { date, format = "json" } = req.query;

    if (!date) {
      throw new ApiError(400, "Date parameter is required");
    }

    let dateObj: Date;
    try {
      const dateStr = (date as string).trim();
      dateObj = dateStr.includes("T")
        ? new Date(dateStr)
        : new Date(`${dateStr}T00:00:00Z`);

      if (isNaN(dateObj.getTime())) {
        throw new Error("Invalid date");
      }
    } catch (err) {
      throw new ApiError(400, "Invalid date format");
    }

    const startOfDay = new Date(dateObj);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date(dateObj);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const query = {
      organizationId: orgId,
      startTime: {
        $gte: startOfDay,
        $lte: endOfDay,
      },
      "customerBooking.isCustomerBooking": true,
    };

    const appointments = await Appointment.find(query)
      .populate({
        path: "createdBy",
        select: "fullName email",
        model: "CrmUser",
      })
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
        `attachment; filename="appointments-${date}.csv"`,
      );
      res.send(csv);
    } else {
      res.json(
        new ApiResponse(
          200,
          { appointments, exportDate: date },
          "Export data ready",
        ),
      );
    }
  },
);

/**
 * GET /api/appointments/dashboard/posts
 * Fetch appointment dashboard posts (visible to all authenticated CRM users)
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
      .select("type title content authorName authorRole createdAt updatedAt")
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

export default {
  getAppointmentsDashboard,
  getAppointmentsDashboardStats,
  exportAppointmentsDashboard,
  getAppointmentDashboardPosts,
  createAppointmentDashboardPost,
};
