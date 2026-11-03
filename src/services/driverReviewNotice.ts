import mongoose from "mongoose";
import User from "../models/User.model";
import notificationService from "./notification.service";
import logger from "../utils/logger";

/*
 * When a driver sends their verification for review, the people who approve
 * drivers are told (decided 2026-11-02), so an application doesn't wait
 * unnoticed while the driver can't work. That's Suprah AI's super admins, who
 * review the shared driver pool, and the admins of the driver's own
 * dealership when they joined through one. Other dealerships aren't told.
 */

/** The notice's title and message, in plain English. */
export function driverReviewNotice(driverName: unknown): { title: string; message: string } {
  const name = String(driverName ?? "").trim() || "A driver";
  return {
    title: "Driver Ready for Review",
    message: `${name} sent their driver verification for review. Open Driver Tracker to check their documents and approve them.`,
  };
}

/** Tells the reviewers. Never throws: the driver's submission stands either way. Returns how many were told. */
export async function notifyDriverReviewers(driver: { _id?: unknown; name?: unknown; organizationId?: unknown }): Promise<number> {
  const driverId = String(driver._id ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(driverId)) return 0;
  const orgId = String(driver.organizationId ?? "").trim();
  try {
    const reviewers: any[] = await User.find({
      $or: [
        { role: "super_admin" },
        ...(mongoose.Types.ObjectId.isValid(orgId) ? [{ organizationId: orgId, role: "admin" }] : []),
      ],
      isActive: { $ne: false },
    })
      .select("_id organizationId")
      .lean();
    const { title, message } = driverReviewNotice(driver.name);
    await Promise.all(
      reviewers.map((reviewer) =>
        notificationService
          .createNotification({
            userId: String(reviewer._id),
            organizationId: String(reviewer.organizationId ?? "").trim() || orgId || "global",
            type: "driver_request",
            title,
            message,
            metadata: {
              driverId,
              // Information only: no Approve/Reject buttons on the phone notification.
              suppressActions: true,
              route: `/driver-tracker?driverId=${encodeURIComponent(driverId)}`,
            },
          })
          .catch((err: unknown) => logger.warn({ err, driverId }, "Could not tell a reviewer about a driver ready for review")),
      ),
    );
    return reviewers.length;
  } catch (err) {
    logger.error({ err, driverId }, "Could not tell reviewers about a driver ready for review");
    return 0;
  }
}
