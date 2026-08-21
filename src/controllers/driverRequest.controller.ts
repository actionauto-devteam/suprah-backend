import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverRequest from "../models/DriverRequest.model";
import User, { IUser } from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import notificationService from "../services/notification.service";
import emailService from "../services/email.service";
import logger from "../utils/logger";
import activityService from "../services/activity.service";

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) {
    throw new ApiError(401, "User not authenticated");
  }
  return user._id.toString();
};

const createDriverRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const currentUser = req.user as IUser;

    const existingRequest = await DriverRequest.findOne({
      driverUserId: userId,
      status: "pending",
    });

    if (existingRequest) {
      throw new ApiError(400, "You already have a pending driver request");
    }

    const approvedRequest = await DriverRequest.findOne({
      driverUserId: userId,
      status: "approved",
    });

    if (approvedRequest) {
      throw new ApiError(400, "Your driver account is already approved");
    }

    const driverRequest = await DriverRequest.create({
      driverUserId: userId,
      status: "pending",
    });

    // Drivers are a shared platform-wide pool — only the SUPRAH.AI
    // super_admin reviews and approves new driver applications.
    const recipients = await User.find({ role: "super_admin" });

    for (const admin of recipients) {
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
      }
    }

    logger.info({ driverRequestId: driverRequest._id, userId }, 'Driver registration request submitted');

    res.status(201).json(
      new ApiResponse(201, driverRequest, "Driver request submitted"),
    );
  },
);

const getMyDriverRequestStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);

    const request = await DriverRequest.findOne({ driverUserId: userId })
      .sort({ createdAt: -1 });

    const user = req.user as IUser;

    if (!request) {
      if (user.role === 'driver' && user.isApproved) {
        return res.json(new ApiResponse(200, { status: "approved" }, "Driver is auto-approved"));
      }
      res.json(new ApiResponse(200, { status: "no-request" }, "No driver request found"));
      return;
    }

    if (user.role === 'driver' && user.isApproved && request.status !== 'approved') {
      request.status = 'approved';
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

const getDriverRequests = asyncHandler(
  async (req: Request, res: Response) => {
    // Route is super_admin-only (see driverRequest.routes.ts) — drivers are a
    // shared platform-wide pool, so there's no org to scope this list by.
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

// GET /api/driver-requests/by-driver/:userId — used by the super-admin
// driver-detail review page to show that driver's request status inline.
// Route is super_admin-only (see driverRequest.routes.ts).
const getDriverRequestByDriver = asyncHandler(
  async (req: Request, res: Response) => {
    const request = await DriverRequest.findOne({ driverUserId: req.params.userId }).sort({ createdAt: -1 });

    res.json(new ApiResponse(200, request, "Driver request fetched"));
  },
);

const approveDriverRequest = asyncHandler(
  async (req: Request, res: Response) => {
    // Route is super_admin-only (see driverRequest.routes.ts).
    const adminUser = req.user as IUser;

    const request = await DriverRequest.findOne({
      _id: req.params.id,
      status: "pending",
    });

    if (!request) {
      throw new ApiError(404, "Driver request not found or already processed");
    }

    const driverUser = await User.findById(request.driverUserId);
    if (!driverUser) {
      throw new ApiError(404, "Driver user not found");
    }

    driverUser.role = "driver";
    driverUser.isApproved = true;
    driverUser.onboardingCompleted = true;
    // Drivers are a shared platform-wide pool — approval does not assign
    // them to any organization.
    await driverUser.save();

    request.status = "approved";
    request.reviewedBy = adminUser._id as any;
    request.reviewedAt = new Date();
    await request.save();

    // Keep the compliance-document review in sync with the account-level
    // decision so admins don't have to separately flip it in two places.
    try {
      await DriverProfile.findOneAndUpdate(
        { userId: driverUser._id },
        { verificationStatus: "verified" },
      );
    } catch (err) {
      logger.error({ err, driverId: driverUser._id }, "Non-fatal: failed to sync DriverProfile verificationStatus on approve");
    }

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
    }

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
      logger.error({ err: emailErr, driverId: driverUser._id }, 'Failed to send driver approval email');
    }

    await activityService.createActivity({
      userId: driverUser._id.toString(),
      organizationId: 'global',
      type: 'profile_update',
      title: 'Driver Approved',
      description: `Account upgraded to Driver role by admin ${adminUser.name}`,
      metadata: { driverRequestId: request._id.toString(), adminId: adminUser._id.toString() }
    });

    logger.info({ driverRequestId: request._id, driverId: driverUser._id, adminId: adminUser._id }, 'Driver request approved');

    res.json(new ApiResponse(200, request, "Driver request approved"));
  },
);

const rejectDriverRequest = asyncHandler(
  async (req: Request, res: Response) => {
    // Route is super_admin-only (see driverRequest.routes.ts).
    const adminUser = req.user as IUser;

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

        try {
          await emailService.sendEmail({
            to: driverUser.email,
            subject: "Update on Your Driver Application - Action Auto",
            text: `Hi ${driverUser.name},\n\nThank you for applying to join Action Auto as a driver. After review, we're unable to approve your application at this time.\n\nIf you believe this was a mistake or would like more information, please contact your administrator.\n\n— Action Auto Team`,
            html: `
              <!DOCTYPE html>
              <html>
              <head>
                <style>
                  body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
                  .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                  .header { background: #6b7280; color: white; padding: 30px 20px; text-align: center; }
                  .header h1 { margin: 0; font-size: 24px; }
                  .content { padding: 30px; }
                  .notice-box { background: #f9fafb; border-left: 4px solid #6b7280; padding: 20px; border-radius: 4px; margin: 20px 0; }
                  .footer { text-align: center; color: #6b7280; font-size: 12px; padding: 20px; background: #f9fafb; border-top: 1px solid #e5e7eb; }
                </style>
              </head>
              <body>
                <div class="container">
                  <div class="header">
                    <h1>Application Update</h1>
                    <p style="margin: 8px 0 0 0; opacity: 0.9;">Action Auto Driver Portal</p>
                  </div>
                  <div class="content">
                    <p style="font-size: 16px;">Hi <strong>${driverUser.name}</strong>,</p>
                    <div class="notice-box">
                      <p style="margin: 0; font-size: 16px; font-weight: bold; color: #374151;">We're unable to approve your driver application at this time.</p>
                      <p style="margin: 8px 0 0 0; color: #4b5563;">If you believe this was a mistake or would like more information, please contact your administrator.</p>
                    </div>
                  </div>
                  <div class="footer">
                    <p>Action Auto Team</p>
                  </div>
                </div>
              </body>
              </html>
            `,
          });
        } catch (emailErr) {
          logger.error({ err: emailErr, driverId: driverUser._id }, 'Failed to send driver rejection email');
        }
      }
    } catch {
    }

    logger.warn({ driverRequestId: request._id, adminId: adminUser._id }, 'Driver request rejected');

    res.json(new ApiResponse(200, request, "Driver request rejected"));
  },
);

export default {
  createDriverRequest,
  getMyDriverRequestStatus,
  getDriverRequests,
  getDriverRequestByDriver,
  approveDriverRequest,
  rejectDriverRequest,
};
