import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';

/**
 * Middleware to resolve and validate organization context for leads
 * 
 * Flow:
 * 1. Extract vehicleId from request body
 * 2. Fetch Vehicle from DB
 * 3. Verify vehicle belongs to an organization
 * 4. Security Check: 
 *    - Customers: Can inquire about any active vehicle.
 *    - Staff (Admin/Dealer): Can only inquire/process for their OWN organization's vehicles.
 * 5. Attach resolved context to req.leadContext
 */
export const resolveLeadContext = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { vehicleId } = req.body;

  if (!vehicleId) {
    throw new ApiError(400, 'Vehicle ID is required to establish lead context');
  }

  // 1. Fetch Vehicle
  const vehicle = await Vehicle.findById(vehicleId);
  if (!vehicle || vehicle.isDeleted) {
    throw new ApiError(404, 'Vehicle not found or no longer available');
  }

  const targetOrgId = vehicle.organizationId?.toString();
  if (!targetOrgId) {
    throw new ApiError(400, 'Vehicle is not properly associated with a dealership organization');
  }

  // 2. Security / Multi-Tenancy Enforcement
  const user = req.user;
  if (!user) {
    throw new ApiError(401, 'User context not found');
  }

  // RBAC: If the user is staff (admin/dealer/employee), they MUST belong to the vehicle's org
  // Customers are global and can interact across orgs.
  const isStaff = ['admin', 'dealer', 'employee'].includes(user.role);
  
  if (isStaff) {
    const userOrgId = user.organizationId?.toString();
    
    // Super admins can bypass if they are impersonating (handled in auth middleware)
    if (user.role !== 'super_admin' && userOrgId !== targetOrgId) {
      throw new ApiError(403, 'Unauthorized: You do not have permission to create leads for this organization');
    }
  }

  // 3. Attach Context
  req.leadContext = {
    organizationId: targetOrgId,
    vehicle
  };

  next();
});
