import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import ServiceLocation from '../models/ServiceLocation.model';
import { ServiceRecord, ServiceStatus } from '../models/ServiceRecord.model';
import { OwnedVehicle } from '../models/OwnedVehicle.model';

/**
 * @desc    Get all Jiffy Lube locations
 * @route   GET /api/service/locations
 * @access  Private (Authenticated Users)
 */
export const getJiffyLubeLocations = asyncHandler(async (req: Request, res: Response) => {
    const locations = await ServiceLocation.find({ partnerName: 'Jiffy Lube', isActive: true });

    res.status(200).json({
        success: true,
        count: locations.length,
        data: locations
    });
});

/**
 * @desc    Get maintenance reminders for a user's vehicles
 * @route   GET /api/service/reminders
 * @access  Private
 */
export const getMaintenanceReminders = asyncHandler(async (req: Request, res: Response) => {
    // This will be implemented fully once OwnedVehicle model is ready
    res.status(200).json({
        success: true,
        data: [],
        message: "Maintenance reminders logic pending OwnedVehicle implementation"
    });
});

/**
 * @desc    Log a new service event for an owned vehicle
 * @route   POST /api/service/log
 * @access  Private
 */
export const logServiceEvent = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const { vehicleId, serviceType, date, mileageAtService, locationName, cost, notes } = req.body;

    if (!vehicleId || !serviceType || !mileageAtService || !locationName) {
        throw new ApiError(400, 'vehicleId, serviceType, mileageAtService, and locationName are required');
    }

    // 1. Verify the user actually owns this vehicle
    const vehicle = await OwnedVehicle.findOne({ _id: vehicleId, userId });

    if (!vehicle) {
        throw new ApiError(403, 'You do not have permission to log service for this vehicle');
    }

    // 2. Create the service record
    const record = await ServiceRecord.create({
        vehicleId,
        serviceType,
        date: date || new Date(),
        mileageAtService,
        locationName,
        cost,
        notes
    });

    // 3. Automatically upgrade the vehicle's master mileage if this service is the newest known reading
    if (mileageAtService > vehicle.currentMileage) {
        vehicle.currentMileage = mileageAtService;
        await vehicle.save();
    }

    res.status(201).json({
        success: true,
        data: record
    });
});

/**
 * @desc    Get the service history (digital logbook) for a specific vehicle
 * @route   GET /api/service/history/:vehicleId
 * @access  Private
 */
export const getVehicleServiceHistory = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const { vehicleId } = req.params;

    const vehicle = await OwnedVehicle.findOne({ _id: vehicleId, userId });
    if (!vehicle) throw new ApiError(403, 'Unauthorized access to vehicle history');

    const records = await ServiceRecord.find({ vehicleId }).sort({ date: -1 });

    res.status(200).json({
        success: true,
        count: records.length,
        data: records
    });
});

/**
 * @desc    Get the active (in-progress) service record for a vehicle — customer polling
 * @route   GET /api/service/active/:vehicleId
 * @access  Private
 */
export const getActiveServiceStatus = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const { vehicleId } = req.params;

    const vehicle = await OwnedVehicle.findOne({ _id: vehicleId, userId });
    if (!vehicle) throw new ApiError(403, 'Unauthorized');

    const activeRecord = await ServiceRecord.findOne({
        vehicleId,
        serviceStatus: { $in: ['received', 'in_service', 'quality_check', 'ready'] },
    }).sort({ updatedAt: -1 });

    res.status(200).json({
        success: true,
        data: activeRecord || null,
    });
});

const VALID_STATUSES: ServiceStatus[] = ['received', 'in_service', 'quality_check', 'ready', 'completed'];

/**
 * @desc    Update service status — staff only (admin / employee)
 * @route   PATCH /api/service/status/:serviceId
 * @access  Private (admin / employee)
 */
export const updateServiceStatus = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const { serviceId } = req.params;
    const { status } = req.body as { status: ServiceStatus };

    if (!status || !VALID_STATUSES.includes(status)) {
        throw new ApiError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const record = await ServiceRecord.findByIdAndUpdate(
        serviceId,
        {
            serviceStatus: status,
            statusUpdatedAt: new Date(),
            statusUpdatedBy: userId,
        },
        { new: true }
    );

    if (!record) throw new ApiError(404, 'Service record not found');

    res.status(200).json({
        success: true,
        data: record,
    });
});
