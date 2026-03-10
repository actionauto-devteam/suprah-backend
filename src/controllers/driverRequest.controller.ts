import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverRequest from "../models/DriverRequest.model";
import User, { IUser } from "../models/User.model";
import Organization from "../models/Organization.model";
import notificationService from "../services/notification.service";
import emailService from "../services/email.service";

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) {
    throw new ApiError(401, "User not authenticated");
  }
  return user._id.toString();
};

/**
 * POST /api/driver-requests
 * Driver submits a registration request — no dealer email needed.
 * Notifies all super_admin users automatically.
 * Auth required, NO org required
 */
const createDriverRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const currentUser = req.user as IUser;

    // Prevent duplicate pending requests
    const existingRequest = await DriverRequest.findOne({
      driverUserId: userId,
      status: "pending",
    });

    if (existingRequest) {
      throw new ApiError(400, "You already have a pending driver request");
    }

    // Also reject if already approved
    const approvedRequest = await DriverRequest.findOne({
      driverUserId: userId,
      status: "approved",
    });

    if (approvedRequest) {
      throw new ApiError(400, "Your driver account is already approved");
    }

    // Create the request (no dealerEmail, no organizationId)
    const driverRequest = await DriverRequest.create({
      driverUserId: userId,
      status: "pending",
    });

    // Notify all super_admin users
    const superAdmins = await User.find({ role: "super_admin" });

    for (const admin of superAdmins) {
      try {
        await notificationService.createNotification({
          userId: admin._id.toString(),
          organizationId: admin.organizationId?.toString() || "global",
          type: "driver_request",
          title: "New Driver Request",
          message: `${currentUser.name} (${currentUser.email}) wants to register as a driver.`,
          metadata: {
            driverRequestId: driverRequest._id.toString(),
            driverName: currentUser.name,
            driverEmail: currentUser.email,
          },
        });
      } catch {
        // Non-critical — continue even if notification fails
      }
    }

    res.status(201).json(
      new ApiResponse(201, driverRequest, "Driver request submitted"),
    );
  },
);

/**
 * GET /api/driver-requests/my-status
 * Driver checks their request status
 * Auth required, NO org required
 */
const getMyDriverRequestStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);

    const request = await DriverRequest.findOne({ driverUserId: userId })
      .sort({ createdAt: -1 });

    if (!request) {
      res.json(new ApiResponse(200, { status: "no-request" }, "No driver request found"));
      return;
    }

    const data = {
      _id: request._id,
      status: request.status,
      createdAt: request.createdAt,
      reviewedAt: request.reviewedAt,
    };

    res.json(new ApiResponse(200, data, "Driver request status"));
  },
);

/**
 * GET /api/driver-requests
 * Super admin lists all driver requests
 * Auth required
 */
const getDriverRequests = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as IUser;

    if (user.role !== "super_admin") {
      throw new ApiError(403, "Only super admins can view driver requests");
    }

    const { status } = req.query;

    const filter: any = {};
    if (status && status !== "all") {
      filter.status = status;
    }

    const requests = await DriverRequest.find(filter)
      .populate("driverUserId", "name email avatar")
      .populate("reviewedBy", "name")
      .sort({ createdAt: -1 });

    res.json(new ApiResponse(200, requests, "Driver requests fetched"));
  },
);

/**
 * PATCH /api/driver-requests/:id/approve
 * Super admin approves a driver request
 * Auth required
 */
const approveDriverRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const adminUser = req.user as IUser;

    if (adminUser.role !== "super_admin") {
      throw new ApiError(403, "Only super admins can approve driver requests");
    }

    const request = await DriverRequest.findOne({
      _id: req.params.id,
      status: "pending",
    });

    if (!request) {
      throw new ApiError(404, "Driver request not found or already processed");
    }

    // Update the driver user — set role to 'driver'
    const driverUser = await User.findById(request.driverUserId);
    if (!driverUser) {
      throw new ApiError(404, "Driver user not found");
    }

    driverUser.role = "driver";
    if (request.organizationId) {
      driverUser.organizationId = request.organizationId;
    }
    await driverUser.save();

    // Update the request
    request.status = "approved";
    request.reviewedBy = adminUser._id as any;
    request.reviewedAt = new Date();
    await request.save();

    // Notify the driver (in-system)
    try {
      await notificationService.createNotification({
        userId: driverUser._id.toString(),
        organizationId: "global",
        type: "driver_request_approved",
        title: "Request Approved",
        message:
          "Your driver request has been approved. You can now access your driver dashboard.",
        metadata: {
          driverRequestId: request._id.toString(),
        },
      });
    } catch {
      // Non-critical
    }

    // Send approval email to driver
    try {
      await emailService.sendEmail({
        to: driverUser.email,
        subject: "Your Driver Account Has Been Approved - Action Auto",
        text: `Hi ${driverUser.name},\n\nGreat news! Your driver account has been approved.\n\nYou can now log in to your Driver Dashboard and start receiving load assignments.\n\nLog in at: ${process.env.FRONTEND_URL || "http://localhost:3000"}/sign-in\n\nWelcome aboard!\n— Action Auto Team`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
              .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
              .header { background: #10b981; color: white; padding: 30px 20px; text-align: center; }
              .header h1 { margin: 0; font-size: 24px; }
              .content { padding: 30px; }
              .success-box { background: #ecfdf5; border-left: 4px solid #10b981; padding: 20px; border-radius: 4px; margin: 20px 0; }
              .btn { display: inline-block; background: #10b981; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 16px; }
              .footer { text-align: center; color: #6b7280; font-size: 12px; padding: 20px; background: #f9fafb; border-top: 1px solid #e5e7eb; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>Account Approved!</h1>
                <p style="margin: 8px 0 0 0; opacity: 0.9;">Welcome to Action Auto Driver Portal</p>
              </div>
              <div class="content">
                <p style="font-size: 16px;">Hi <strong>${driverUser.name}</strong>,</p>
                <div class="success-box">
                  <p style="margin: 0; font-size: 16px; font-weight: bold; color: #065f46;">Your driver account has been approved!</p>
                  <p style="margin: 8px 0 0 0; color: #047857;">You can now log in to your Driver Dashboard and start receiving load assignments.</p>
                </div>
                <p style="text-align: center;">
                  <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/sign-in" class="btn">Log In to Dashboard</a>
                </p>
                <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">If you have any questions, reach out to your administrator.</p>
              </div>
              <div class="footer">
                <p><strong>Action Auto - Driver Portal</strong></p>
                <p>This is an automated notification.</p>
              </div>
            </div>
          </body>
          </html>
        `,
      });
    } catch (emailErr) {
      console.error("Failed to send approval email:", emailErr);
    }

    res.json(new ApiResponse(200, request, "Driver request approved"));
  },
);

/**
 * PATCH /api/driver-requests/:id/reject
 * Super admin rejects a driver request
 * Auth required
 */
const rejectDriverRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const adminUser = req.user as IUser;

    if (adminUser.role !== "super_admin") {
      throw new ApiError(403, "Only super admins can reject driver requests");
    }

    const request = await DriverRequest.findOne({
      _id: req.params.id,
      status: "pending",
    });

    if (!request) {
      throw new ApiError(404, "Driver request not found or already processed");
    }

    request.status = "rejected";
    request.reviewedBy = adminUser._id as any;
    request.reviewedAt = new Date();
    await request.save();

    // Notify the driver
    try {
      const driverUser = await User.findById(request.driverUserId);
      if (driverUser) {
        await notificationService.createNotification({
          userId: driverUser._id.toString(),
          organizationId: "global",
          type: "driver_request_rejected",
          title: "Request Rejected",
          message:
            "Your driver request has been rejected. Please contact the administrator for more information.",
          metadata: {
            driverRequestId: request._id.toString(),
          },
        });
      }
    } catch {
      // Non-critical
    }

    res.json(new ApiResponse(200, request, "Driver request rejected"));
  },
);

export default {
  createDriverRequest,
  getMyDriverRequestStatus,
  getDriverRequests,
  approveDriverRequest,
  rejectDriverRequest,
};
