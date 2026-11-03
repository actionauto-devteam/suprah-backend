import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { isOnMarketplace, VEHICLE_NOT_FOR_SALE } from '../utils/marketplaceVehicle';

export const resolveLeadContext = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { vehicleId } = req.body;

  if (!vehicleId) {
    throw new ApiError(400, 'Vehicle ID is required to establish lead context');
  }

  const vehicle = await Vehicle.findById(vehicleId);
  if (!vehicle || vehicle.isDeleted) {
    throw new ApiError(404, 'Vehicle not found or no longer available');
  }

  const targetOrgId = vehicle.organizationId?.toString();
  if (!targetOrgId) {
    throw new ApiError(400, 'Vehicle is not properly associated with a dealership organization');
  }

  const user = req.user;
  if (!user) {
    throw new ApiError(401, 'User context not found');
  }

  const isStaff = ['admin', 'dealer', 'employee'].includes(user.role);

  if (isStaff) {
    const userOrgId = user.organizationId?.toString();

    if (user.role !== 'super_admin' && userOrgId !== targetOrgId) {
      throw new ApiError(403, 'Unauthorized: You do not have permission to create leads for this organization');
    }
  } else if (user.role !== 'super_admin' && !isOnMarketplace(vehicle)) {
    // Customers can only ask about or apply for cars that are for sale.
    throw new ApiError(404, VEHICLE_NOT_FOR_SALE);
  }

  req.leadContext = {
    organizationId: targetOrgId,
    vehicle
  };

  next();
});
