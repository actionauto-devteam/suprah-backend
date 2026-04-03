import express from "express";
import authMiddleware from "../middleware/auth.middleware";
import User from "../models/User.model";
import DriverRequest from "../models/DriverRequest.model";
import DriverProfile from "../models/DriverProfile.model";
import { ApiResponse } from "../utils/ApiResponse";
import { asyncHandler } from "../utils/asyncHandler";
import config from "../config";

const router = express.Router();

router.use(authMiddleware());

router.post(
  "/switch-role",
  asyncHandler(async (req, res) => {
    if (config.env === "production") {
      return res.status(403).json(new ApiResponse(403, null, "Not available in production"));
    }

    const user = req.user!;
    const { role } = req.body;
    const validRoles = ["customer", "employee", "admin", "super_admin", "driver"];

    if (!role || !validRoles.includes(role)) {
      return res.status(400).json(new ApiResponse(400, null, `Invalid role. Use: ${validRoles.join(", ")}`));
    }

    if (!["admin", "super_admin"].includes(user.role)) {
      return res.status(403).json(new ApiResponse(403, null, "Only admin or super_admin can switch roles"));
    }

    const originalRole = user.role;
    const updated = await User.findByIdAndUpdate(
      user._id,
      { role, ...(role === "driver" ? { isApproved: true } : {}) },
      { new: true }
    ).select("-password");

    if (role === "driver") {
      await DriverRequest.findOneAndUpdate(
        { driverUserId: user._id },
        {
          driverUserId: user._id,
          organizationId: user.organizationId,
          status: "approved",
          reviewedBy: user._id,
          reviewedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      await DriverProfile.findOneAndUpdate(
        { userId: user._id },
        {
          userId: user._id,
          organizationId: user.organizationId?.toString() || "",
          operationalStatus: "active",
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    return res.json(
      new ApiResponse(200, { user: updated, originalRole, currentRole: role }, "Role switched")
    );
  })
);

router.post(
  "/restore-role",
  asyncHandler(async (req, res) => {
    if (config.env === "production") {
      return res.status(403).json(new ApiResponse(403, null, "Not available in production"));
    }

    const { role } = req.body;
    const validRoles = ["customer", "employee", "admin", "super_admin", "driver"];

    if (!role || !validRoles.includes(role)) {
      return res.status(400).json(new ApiResponse(400, null, `Invalid role. Use: ${validRoles.join(", ")}`));
    }

    const updated = await User.findByIdAndUpdate(req.user!._id, { role }, { new: true }).select("-password");

    return res.json(new ApiResponse(200, { user: updated, currentRole: role }, "Role restored"));
  })
);

export default router;
