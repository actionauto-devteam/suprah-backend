import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import vehicleHistoryService from "../services/vehicleHistory.service";

/**
 * GET /api/appointments/dashboard/vehicle-history
 * Optional query: ?startDate=&endDate=&status=all|sold|available|test-driven
 */
const getVehicleHistory = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { startDate, endDate, status } = req.query;

  const result = await vehicleHistoryService.getVehicleHistory(orgId, {
    startDate: startDate ? new Date(startDate as string) : undefined,
    endDate: endDate ? new Date(endDate as string) : undefined,
    status: status as any,
  });

  res.json(
    new ApiResponse(200, result, "Vehicle history fetched successfully"),
  );
});

export default { getVehicleHistory };