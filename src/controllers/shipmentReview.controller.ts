import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { SIGN_IN_AGAIN } from "../utils/userMessages";
import type { IUser } from "../models/User.model";
import { confirmShipmentReceived, loadCustomerReview, reviewShipment } from "../services/shipmentReview.service";

/*
 * "Confirm received" and reviews on a delivered shipment (see
 * services/shipmentReview.service.ts).
 */

const signedInUser = (req: Request): IUser => {
  const user = req.user as IUser | undefined;
  if (!user?._id) throw new ApiError(401, SIGN_IN_AGAIN);
  return user;
};

/** POST /api/quote-requests/:id/received — the customer confirms, optionally with their review. */
const confirmReceived = asyncHandler(async (req: Request, res: Response) => {
  const result = await confirmShipmentReceived(String(signedInUser(req)._id), req.params.id, req.body);
  const message = result.alreadyConfirmed
    ? "You'd already confirmed you received this vehicle."
    : result.receipt.reviewed
      ? "Thanks! You confirmed you received your vehicle, and your review was sent."
      : "Thanks! You confirmed you received your vehicle.";
  return res.status(200).json(new ApiResponse(200, result.receipt, message));
});

/** POST /api/quote-requests/:id/review — the customer's one review of the delivery. */
const review = asyncHandler(async (req: Request, res: Response) => {
  const result = await reviewShipment(String(signedInUser(req)._id), req.params.id, req.body);
  return res.status(200).json(new ApiResponse(200, result.receipt, "Thanks! Your review was sent."));
});

/** GET /api/driver-tracking/loads/:loadId/customer-review — the load's own dealership. */
const getLoadReview = asyncHandler(async (req: Request, res: Response) => {
  const view = await loadCustomerReview(signedInUser(req), req.orgId, req.params.loadId);
  return res.status(200).json(new ApiResponse(200, view, view ? "Customer review" : "No confirmation from the customer yet"));
});

export default { confirmReceived, review, getLoadReview };
