import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { IUser } from "../models/User.model";
import { listCalendarShipments } from "../services/calendarShipments.service";

/**
 * Pickup windows and delivery deadlines for the Suprah Calendar
 * GET /api/loads/calendar?from=<ISO>&to=<ISO>
 * Admins get all live loads; anyone else only the loads they dispatch.
 */
const getCalendarShipments = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const organizationId = req.orgId as string;
  const effectiveRole = String((req as { orgRole?: string }).orgRole ?? user.role ?? "");
  const isAdmin = user.role === "super_admin" || ["admin", "super_admin"].includes(effectiveRole);
  const items = await listCalendarShipments({
    organizationId,
    userId: user._id.toString(),
    isAdmin,
    from: req.query.from,
    to: req.query.to,
  });
  return res.status(200).json(new ApiResponse(200, { items, scope: isAdmin ? "all" : "mine" }, "Calendar shipments fetched"));
});

export default { getCalendarShipments };
