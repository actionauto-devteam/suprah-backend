import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification, notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { IUser } from '../models/User.model';
import cacheService from '../services/cache.service';
import logger from '../utils/logger';
import activityService from '../services/activity.service';

const VEH_CACHE_TTL = 60 * 60; // 1 hour

/**
 * Helper to safely get user ID from request
 */
const getUserId = (req: Request): string | undefined => {
  return (req.user as IUser)?._id?.toString();
};

const normalizeVehicle = (vehicle: any) => ({
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName,
  modelName: vehicle.modelName,
  trim: vehicle.trim || '',
  color: vehicle.exteriorColor || 'N/A', // Mapping to 'color' for frontend compatibility
  exteriorColor: vehicle.exteriorColor || 'N/A',
  interiorColor: vehicle.interiorColor || 'N/A',
  stockNumber: vehicle.stockNumber || 'N/A',
  price: vehicle.price || 0,
  marketPrice: vehicle.msrp || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || 'Automatic',
  fuelType: vehicle.fuelType || 'Gasoline',
  location: vehicle.dealerCity ? `${vehicle.dealerCity}${vehicle.dealerState ? ', ' + vehicle.dealerState : ''}${vehicle.dealerZip ? ', ' + vehicle.dealerZip : ''}` : 'Unknown',
  image: (vehicle.images && vehicle.images.length > 0) ? vehicle.images[0] : 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
  images: vehicle.images || [],
  status: vehicle.status,
  currentStep: vehicle.currentStep,
  reconStartDate: vehicle.reconStartDate,
  stepEnteredAt: vehicle.stepEnteredAt,
  daysOnLot: vehicle.daysOnLot || 0,
  dateAdded: vehicle.dateAdded,
  dateSold: vehicle.dateSold,
  assignedTo: vehicle.assignedTo,
  notes: vehicle.notes || [],
  comments: vehicle.comments || vehicle.description || '',
});

const normalizePublicVehicle = (vehicle: any) => ({
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName,
  modelName: vehicle.modelName,
  trim: vehicle.trim || '',
  color: vehicle.exteriorColor || 'N/A',
  exteriorColor: vehicle.exteriorColor || 'N/A',
  interiorColor: vehicle.interiorColor || 'N/A',
  stockNumber: vehicle.stockNumber || 'N/A',
  price: vehicle.price || 0,
  marketPrice: vehicle.msrp || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || 'Automatic',
  fuelType: vehicle.fuelType || 'Gasoline',
  location: vehicle.dealerCity ? `${vehicle.dealerCity}${vehicle.dealerState ? ', ' + vehicle.dealerState : ''}${vehicle.dealerZip ? ', ' + vehicle.dealerZip : ''}` : 'Unknown',
  image: (vehicle.images && vehicle.images.length > 0) ? vehicle.images[0] : 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
  images: vehicle.images || [],
  status: vehicle.status,
  daysOnLot: vehicle.daysOnLot || 0,
  comments: vehicle.comments || '',
});

const normalizeCustomerVehicle = (vehicle: any) => ({
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName,
  modelName: vehicle.modelName,
  trim: vehicle.trim || '',
  color: vehicle.exteriorColor || 'N/A',
  exteriorColor: vehicle.exteriorColor || 'N/A',
  interiorColor: vehicle.interiorColor || 'N/A',
  stockNumber: vehicle.stockNumber || 'N/A',
  price: vehicle.price || 0,
  marketPrice: vehicle.msrp || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || 'Automatic',
  fuelType: vehicle.fuelType || 'Gasoline',
  location: vehicle.dealerCity ? `${vehicle.dealerCity}${vehicle.dealerState ? ', ' + vehicle.dealerState : ''}${vehicle.dealerZip ? ', ' + vehicle.dealerZip : ''}` : 'Unknown',
  image: (vehicle.images && vehicle.images.length > 0) ? vehicle.images[0] : 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
  images: vehicle.images || [],
  status: vehicle.status,
  daysOnLot: vehicle.daysOnLot || 0,
  engine: vehicle.engine || '',
  driveTrain: vehicle.driveTrain || '',
  comments: vehicle.comments || '',
  options: vehicle.options || '',
});

const createVehicle = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;

  const vehicle = await Vehicle.create({
    ...req.body,
    organizationId: orgId,
  });

  const vehicleName = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;

  // Notify admins about new vehicle
  if (orgId) {
    const { title, message } = notificationTemplates.vehicle_added({
      vehicleName,
      stockNumber: vehicle.stockNumber,
    });

    await notifyOrgAdmins(
      orgId,
      'vehicle_added',
      title,
      message,
      {
        vehicleId: vehicle._id.toString(),
        vehicleName,
        stockNumber: vehicle.stockNumber,
        vin: vehicle.vin,
      },
      userId // Exclude the user who created it
    );
  }

  await activityService.createActivity({
    userId: userId || 'SYSTEM',
    organizationId: orgId,
    type: 'vehicle_added',
    title: 'Vehicle Added',
    description: `Added ${vehicleName} to inventory`,
    metadata: { vehicleId: vehicle._id.toString(), vin: vehicle.vin, stockNumber: vehicle.stockNumber },
    ipAddress: req.ip
  });

  logger.info({ vehicleId: vehicle._id, vin: vehicle.vin, orgId }, 'New vehicle added to inventory');

  res.status(201).json(
    new ApiResponse(201, normalizeVehicle(vehicle), 'Vehicle created successfully')
  );

  // Invalidate vehicle cache after new vehicle is added
  await cacheService.invalidateByPrefix('veh:');
});

const getVehicles = asyncHandler(async (req: Request, res: Response) => {
  const {
    status,
    search: searchParam,
    q, // Fallback for some frontend search bars
    make,
    model,
    year,
    location,
    minPrice,
    maxPrice,
    minMileage,
    maxMileage,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    page = '1',
    limit = '20'
  } = req.query;

  const search = searchParam || q;

  const filter: any = { isDeleted: false }; // organizationId is handled in pipeline or match below

  if (status && status !== 'all') {
    filter.status = status;
  }

  if (make) {
    filter.make = { $regex: make, $options: 'i' };
  }

  if (model) {
    filter.modelName = { $regex: model, $options: 'i' };
  }

  if (year) {
    filter.year = Number(year);
  }

  if (location) {
    filter.$or = [
      { dealerCity: { $regex: location, $options: 'i' } },
      { dealerState: { $regex: location, $options: 'i' } }
    ];
  }

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (minMileage || maxMileage) {
    filter.mileage = {};
    if (minMileage) filter.mileage.$gte = Number(minMileage);
    if (maxMileage) filter.mileage.$lte = Number(maxMileage);
  }

  if (req.query.bodyStyle) {
    filter.bodyStyle = { $regex: req.query.bodyStyle, $options: 'i' };
  }

  if (req.query.driveTrain) {
    filter.driveTrain = { $regex: req.query.driveTrain, $options: 'i' };
  }

  if (req.query.minDaysOnLot || req.query.maxDaysOnLot) {
    filter.daysOnLot = {};
    if (req.query.minDaysOnLot) filter.daysOnLot.$gte = Number(req.query.minDaysOnLot);
    if (req.query.maxDaysOnLot) filter.daysOnLot.$lte = Number(req.query.maxDaysOnLot);
  }

  if (req.query.minCost || req.query.maxCost) {
    filter.cost = {};
    if (req.query.minCost) filter.cost.$gte = Number(req.query.minCost);
    if (req.query.maxCost) filter.cost.$lte = Number(req.query.maxCost);
  }

  const sortObj: any = {};
  const order = sortOrder === 'desc' ? -1 : 1;

  switch (sortBy) {
    case 'stockNumber':
      sortObj.stockNumber = order;
      break;
    case 'year':
      sortObj.year = order;
      break;
    case 'make':
      sortObj.make = order;
      sortObj.modelName = order;
      break;
    case 'location':
      sortObj.dealerCity = order;
      sortObj.dealerState = order;
      break;
    case 'mileage':
      sortObj.mileage = order;
      break;
    case 'cost':
      sortObj.cost = order;
      break;
    case 'price':
      sortObj.price = order;
      break;
    case 'age':
      sortObj.daysOnLot = order;
      break;
    case 'status':
      sortObj.status = order;
      break;
    case 'updated':
      sortObj.updatedAt = order;
      break;
    case 'created':
    case 'recent':
      sortObj.dateAdded = order;
      break;
    default:
      sortObj.make = 1;
      sortObj.modelName = 1;
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  // Build Aggregation Pipeline
  const pipeline: any[] = [];

  // Stage 1: Search (Must be first)
  if (search) {
    const searchString = search.toString();
    const isNumericSearch = !isNaN(Number(searchString));
    
    const shouldClauses: any[] = [
      {
        text: {
          query: searchString,
          path: ['make', 'modelName', 'vin', 'stockNumber'],
          fuzzy: { maxEdits: 1 }
        }
      }
    ];

    // If the search is a number (like 2024), add a numeric match for the 'year' field
    if (isNumericSearch) {
      shouldClauses.push({
        equals: {
          value: Number(searchString),
          path: 'year'
        }
      });
    }

    pipeline.push({
      $search: {
        index: 'Vehicle',
        compound: {
          must: [
            {
              equals: {
                value: req.orgId,
                path: 'organizationId'
              }
            },
            {
              compound: {
                should: shouldClauses,
                minimumShouldMatch: 1
              }
            }
          ]
        }
      }
    });
  } else {
    pipeline.push({ $match: { organizationId: req.orgId, isDeleted: false } });
  }

  // Stage 2: Filter matching
  pipeline.push({ $match: filter });

  // Stage 3: Sorting
  pipeline.push({ $sort: sortObj });

  // Stage 4: Pagination & Metadata Facets
  pipeline.push({
    $facet: {
      metadata: [{ $count: 'total' }],
      data: [
        { $skip: skip },
        { $limit: limitNum > 0 ? limitNum : 100 },
        {
          $lookup: {
            from: 'users',
            localField: 'assignedTo',
            foreignField: '_id',
            as: 'assignedTo'
          }
        },
        {
          $unwind: {
             path: '$assignedTo',
             preserveNullAndEmptyArrays: true
          }
        },
        {
          $project: {
            'assignedTo.password': 0,
            'assignedTo.otp': 0,
            'assignedTo.otpExpires': 0
          }
        }
      ]
    }
  });

  console.log('[DEBUG] Vehicle Pipeline:', JSON.stringify(pipeline, null, 2));
  const [result] = await Vehicle.aggregate(pipeline);
  
  const total = result.metadata[0]?.total || 0;
  const vehicles = result.data || [];
  const normalized = vehicles.map((v: any) => normalizeVehicle(v));

  const responseData: any = {
    vehicles: normalized,
    total
  };

  responseData.pagination = {
    page: pageNum,
    limit: limitNum,
    total,
    totalPages: limitNum > 0 ? Math.ceil(total / limitNum) : 1
  };

  res.json(new ApiResponse(200, responseData, 'Vehicles fetched successfully'));
});

const getVehicleById = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const isStaff = user && (user.role === 'admin' || user.role === 'super_admin' || (user as any).organizationRole === 'employee');
  const orgId = req.orgId as string;

  let query: any = { _id: req.params.id, isDeleted: false };
  
  // If staff, we usually restrict to their organization unless super_admin
  if (isStaff && user.role !== 'super_admin') {
    query.organizationId = orgId;
  }

  const vehicle = await Vehicle.findOne(query)
    .populate('assignedTo', 'email name');

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  // Role-based normalization
  if (isStaff) {
    res.json(new ApiResponse(200, normalizeVehicle(vehicle), 'Vehicle fetched successfully'));
  } else {
    // For customers or cross-org checks, return filtered data
    res.json(new ApiResponse(200, normalizeCustomerVehicle(vehicle), 'Vehicle fetched successfully'));
  }
});

/**
 * Publicly accessible vehicle data (sanitized)
 */
const getPublicVehicleById = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false })
    .select('-cost -notes -assignedTo -organizationId -dealerEmail -isDeleted -manualStatusLock');

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  // Double check status - normally we only show 'Ready for Sale' publicly
  // But we allow others if explicitly shared, as long as sensitive data is scrubbed.
  
  res.json(new ApiResponse(200, normalizePublicVehicle(vehicle), 'Public vehicle data fetched successfully'));
});

const updateVehicle = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const existingVehicle = await Vehicle.findOne({ _id: req.params.id, organizationId: orgId });

  if (!existingVehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  const updateData = { ...req.body };
  const oldStatus = existingVehicle.status;

  if (updateData.currentStep && updateData.currentStep !== existingVehicle.currentStep) {
    updateData.stepEnteredAt = new Date();
  }

  if (updateData.status && updateData.status !== existingVehicle.status) {
    updateData.manualStatusLock = true;
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId },
    updateData,
    { new: true, runValidators: true }
  ).populate('assignedTo', 'email name');

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  const vehicleName = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;

  // Notify on status change (especially if sold)
  if (orgId && updateData.status && updateData.status !== oldStatus) {
    if (updateData.status === 'Sold') {
      const { title, message } = notificationTemplates.vehicle_sold({
        vehicleName,
        stockNumber: vehicle.stockNumber,
        price: vehicle.price,
      });

      await notifyOrgAdmins(
        orgId,
        'vehicle_sold',
        title,
        message,
        {
          vehicleId: vehicle._id.toString(),
          vehicleName,
          stockNumber: vehicle.stockNumber,
          price: vehicle.price,
        },
        userId
      );
    } else {
      const { title, message } = notificationTemplates.vehicle_status_changed({
        vehicleName,
        stockNumber: vehicle.stockNumber,
        status: updateData.status,
      });

      await notifyOrgAdmins(
        orgId,
        'vehicle_status_changed',
        title,
        message,
        {
          vehicleId: vehicle._id.toString(),
          vehicleName,
          oldStatus,
          newStatus: updateData.status,
        },
        userId
      );
    }
  }

  await activityService.createActivity({
    userId: userId || 'SYSTEM',
    organizationId: orgId,
    type: 'vehicle_updated',
    title: 'Vehicle Updated',
    description: `Updated status of ${vehicleName} to ${updateData.status || vehicle.status}`,
    metadata: { vehicleId: vehicle._id.toString(), status: updateData.status, oldStatus }
  });

  logger.info({ vehicleId: vehicle._id, status: vehicle.status, orgId }, 'Vehicle updated');

  res.json(new ApiResponse(200, normalizeVehicle(vehicle), 'Vehicle updated successfully'));

  // Invalidate vehicle cache on any update
  await cacheService.invalidateByPrefix('veh:');
});

const deleteVehicle = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const vehicle = await Vehicle.findOneAndDelete({ _id: req.params.id, organizationId: orgId });

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  if (orgId) {
    const vehicleName = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;
    await notifyOrgAdmins(
      orgId,
      'vehicle_status_changed',
      'Vehicle Deleted',
      `${vehicleName} (Stock #${vehicle.stockNumber || 'N/A'}) was removed from inventory`,
      { vehicleId: req.params.id, vehicleName },
      userId
    );
  }

  await activityService.createActivity({
    userId: userId || 'SYSTEM',
    organizationId: orgId,
    type: 'vehicle_updated',
    title: 'Vehicle Removed',
    description: `Vehicle ${vehicle.year} ${vehicle.make} ${vehicle.modelName} was deleted from inventory`,
    metadata: { vehicleId: req.params.id, vin: vehicle.vin }
  });

  logger.warn({ vehicleId: req.params.id, vin: vehicle.vin, orgId }, 'Vehicle deleted from inventory');

  res.json(new ApiResponse(200, null, 'Vehicle deleted successfully'));

  // Invalidate vehicle cache on delete
  await cacheService.invalidateByPrefix('veh:');
});

const addVehicleNote = asyncHandler(async (req: Request, res: Response) => {
  const { text } = req.body;
  const userId = (req as any).user?._id;
  const orgId = req.orgId as string;

  if (!text) {
    throw new ApiError(400, 'Note text is required');
  }

  if (!userId) {
    throw new ApiError(401, 'User not authenticated');
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId },
    {
      $push: {
        notes: {
          text,
          author: userId,
          date: new Date()
        }
      }
    },
    { new: true }
  ).populate('assignedTo', 'email name')
    .populate('notes.author', 'name email');

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  res.json(new ApiResponse(200, normalizeVehicle(vehicle), 'Note added successfully'));
});

const getFilters = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const cacheKey = `veh:filters:${orgId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.json(new ApiResponse(200, cached, 'Filters fetched successfully'));
  }

  const query = { organizationId: orgId, isDeleted: false };

  const [makes, models, years, locations, bodyStyles, driveTrains] = await Promise.all([
    Vehicle.distinct('make', query),
    Vehicle.distinct('modelName', query),
    Vehicle.distinct('year', query),
    Vehicle.distinct('dealerCity', query),
    Vehicle.distinct('bodyStyle', query),
    Vehicle.distinct('driveTrain', query)
  ]);

  const data = {
    makes: makes.filter(Boolean).sort(),
    models: models.filter(Boolean).sort(),
    years: years.filter(Boolean).sort((a, b) => b - a),
    locations: locations.filter(Boolean).sort(),
    bodyStyles: bodyStyles.filter(Boolean).sort(),
    driveTrains: driveTrains.filter(Boolean).sort()
  };

  await cacheService.set(cacheKey, data, VEH_CACHE_TTL);

  res.json(new ApiResponse(200, data, 'Filters fetched successfully'));
});

const getStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const cacheKey = `veh:stats:${orgId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.json(new ApiResponse(200, cached, 'Statistics fetched successfully'));
  }

  const [total, byStatus, vehicles] = await Promise.all([
    Vehicle.countDocuments({ organizationId: orgId, isDeleted: false }),
    Vehicle.aggregate([
      { $match: { organizationId: orgId, isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Vehicle.find({ organizationId: orgId, isDeleted: false }).select('price daysOnLot')
  ]);

  const statusBreakdown = byStatus.reduce((acc: any, item: any) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  const prices = vehicles.map(v => v.price || 0).filter(p => p > 0);
  const averagePrice = prices.length > 0
    ? Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length)
    : 0;

  const daysOnLot = vehicles.map(v => v.daysOnLot || 0);
  const averageDaysOnLot = daysOnLot.length > 0
    ? Math.round(daysOnLot.reduce((sum, d) => sum + d, 0) / daysOnLot.length)
    : 0;

  const totalValue = prices.reduce((sum, p) => sum + p, 0);

  const data = { total, byStatus: statusBreakdown, averagePrice, averageDaysOnLot, totalValue };

  await cacheService.set(cacheKey, data, VEH_CACHE_TTL);

  res.json(new ApiResponse(200, data, 'Statistics fetched successfully'));
});

const getDashboardGraphs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const salesTrend = await Vehicle.aggregate([
    {
      $match: {
        organizationId: orgId,
        status: 'Sold',
        dateSold: { $gte: sixMonthsAgo }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$dateSold' },
          month: { $month: '$dateSold' }
        },
        sold: { $sum: 1 },
        revenue: { $sum: '$price' }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } }
  ]);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formattedSalesTrend = salesTrend.map(item => ({
    month: monthNames[item._id.month - 1],
    sold: item.sold,
    revenue: item.revenue || 0
  }));

  const inventoryByMake = await Vehicle.aggregate([
    { $match: { organizationId: orgId, isDeleted: false, status: { $ne: 'Sold' } } },
    { $group: { _id: '$make', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]);

  const formattedInventoryByMake = inventoryByMake.map(item => ({
    make: item._id,
    count: item.count
  }));

  const priceDistribution = await Vehicle.aggregate([
    { $match: { organizationId: orgId, isDeleted: false, status: { $ne: 'Sold' }, price: { $gt: 0 } } },
    {
      $bucket: {
        groupBy: '$price',
        boundaries: [0, 20000, 40000, 60000, 80000, 100000, 200000],
        default: '200k+',
        output: { count: { $sum: 1 } }
      }
    }
  ]);

  const priceRangeLabels = ['0-20k', '20k-40k', '40k-60k', '60k-80k', '80k-100k', '100k-200k', '200k+'];
  const formattedPriceDistribution = priceDistribution.map((item, index) => ({
    range: priceRangeLabels[index] || '200k+',
    count: item.count
  }));

  const now = new Date();
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);

  const [currentVehicles, lastMonthVehicles] = await Promise.all([
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      status: { $ne: 'Sold' },
      dateAdded: { $gte: lastMonth }
    }).select('daysOnLot'),
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      status: 'Sold',
      dateSold: { $gte: lastMonth, $lt: now }
    }).select('daysOnLot')
  ]);

  const currentAvg = currentVehicles.length > 0
    ? Math.round(currentVehicles.reduce((sum, v) => sum + (v.daysOnLot || 0), 0) / currentVehicles.length)
    : 0;

  const lastMonthAvg = lastMonthVehicles.length > 0
    ? Math.round(lastMonthVehicles.reduce((sum, v) => sum + (v.daysOnLot || 0), 0) / lastMonthVehicles.length)
    : 0;

  const trend = currentAvg < lastMonthAvg ? 'improving' : currentAvg > lastMonthAvg ? 'declining' : 'stable';

  res.json(new ApiResponse(200, {
    salesTrend: formattedSalesTrend,
    inventoryByMake: formattedInventoryByMake,
    priceDistribution: formattedPriceDistribution,
    daysOnLotAverage: {
      current: currentAvg,
      lastMonth: lastMonthAvg,
      trend
    }
  }, 'Dashboard graphs data fetched successfully'));
});

const updateVehicleStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status, currentStep } = req.body;

  if (!status) {
    throw new ApiError(400, 'Status is required');
  }

  const orgId = req.orgId as string;
  const updateData: any = { status };

  if (currentStep) {
    updateData.currentStep = currentStep;
    updateData.stepEnteredAt = new Date();
  }

  updateData.manualStatusLock = true;

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId },
    updateData,
    { new: true, runValidators: true }
  ).populate('assignedTo', 'email name');

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  res.json(new ApiResponse(200, normalizeVehicle(vehicle), 'Vehicle status updated successfully'));
});

const exportVehicles = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status, search, make, model, year, location, minPrice, maxPrice, minMileage, maxMileage } = req.query;

  const filter: any = {}; // Used for match stage after search

  if (status) {
    if (status !== 'all') {
      filter.status = status;
    }
  } else {
    filter.status = 'Ready for Sale';
  }

  if (make) filter.make = { $regex: make, $options: 'i' };
  if (model) filter.modelName = { $regex: model, $options: 'i' };
  if (year) filter.year = Number(year);
  if (location) {
    filter.$or = [
      { dealerCity: { $regex: location, $options: 'i' } },
      { dealerState: { $regex: location, $options: 'i' } }
    ];
  }

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (minMileage || maxMileage) {
    filter.mileage = {};
    if (minMileage) filter.mileage.$gte = Number(minMileage);
    if (maxMileage) filter.mileage.$lte = Number(maxMileage);
  }

  const pipeline: any[] = [];

  if (search) {
    const searchString = search.toString();
    const isNumericSearch = !isNaN(Number(searchString));
    
    const shouldClauses: any[] = [
      {
        text: {
          query: searchString,
          path: ['make', 'modelName', 'vin', 'stockNumber'],
          fuzzy: { maxEdits: 1 }
        }
      }
    ];

    if (isNumericSearch) {
      shouldClauses.push({
        equals: {
          value: Number(searchString),
          path: 'year'
        }
      });
    }

    pipeline.push({
      $search: {
        index: 'Vehicle',
        compound: {
          must: [
            {
              equals: {
                value: orgId,
                path: 'organizationId'
              }
            },
            {
              compound: {
                should: shouldClauses,
                minimumShouldMatch: 1
              }
            }
          ]
        }
      }
    });
  } else {
    pipeline.push({ $match: { organizationId: orgId, isDeleted: false } });
  }

  pipeline.push({ $match: filter });
  pipeline.push({ $sort: { createdAt: -1 } });

  const vehicles = await Vehicle.aggregate(pipeline);

  const csvHeader = 'VIN,Year,Make,Model,Trim,Color,Stock Number,Price,Mileage,Status,Location,Date Added\n';
  const csvRows = vehicles.map((v: any) =>
    `"${v.vin}",${v.year},"${v.make}","${v.modelName}","${v.trim || ''}","${v.exteriorColor || ''}","${v.stockNumber || ''}",${v.price || 0},${v.mileage || 0},"${v.status}","${v.dealerCity}, ${v.dealerState}",${v.dateAdded ? new Date(v.dateAdded).toISOString().split('T')[0] : ''}`
  ).join('\n');

  const csv = csvHeader + csvRows;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="vehicles-export-${Date.now()}.csv"`);
  res.send(csv);
});

const getDashboard = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const [recentVehicles, stats, alerts] = await Promise.all([
    Vehicle.find({ organizationId: orgId, isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('assignedTo', 'email name'),
    Vehicle.aggregate([
      { $match: { organizationId: orgId, isDeleted: false } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgPrice: { $avg: '$price' }
        }
      }
    ]),
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      status: 'In Recon',
      daysOnLot: { $gt: 30 }
    }).countDocuments()
  ]);

  const statusBreakdown = stats.reduce((acc: any, item: any) => {
    acc[item._id] = {
      count: item.count,
      avgPrice: Math.round(item.avgPrice || 0)
    };
    return acc;
  }, {});

  res.json(new ApiResponse(200, {
    recentVehicles: recentVehicles.map(normalizeVehicle),
    statusBreakdown,
    alerts: {
      longRecon: alerts
    }
  }, 'Dashboard data fetched successfully'));
});

const autocomplete = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { q } = req.query;

  if (!q || (q as string).length < 2) {
    return res.json(new ApiResponse(200, [], 'Query too short'));
  }

  const regex = { $regex: q, $options: 'i' };
  const query = { organizationId: orgId, isDeleted: false };

  const [vins, makes, models, stockNumbers] = await Promise.all([
    Vehicle.distinct('vin', { ...query, vin: regex }),
    Vehicle.distinct('make', { ...query, make: regex }),
    Vehicle.distinct('modelName', { ...query, modelName: regex }),
    Vehicle.distinct('stockNumber', { ...query, stockNumber: regex })
  ]);

  const suggestions = [
    ...vins.map(v => ({ type: 'vin', value: v })),
    ...makes.map(m => ({ type: 'make', value: m })),
    ...models.map(m => ({ type: 'model', value: m })),
    ...stockNumbers.filter(Boolean).map(s => ({ type: 'stock', value: s }))
  ].slice(0, 10);

  res.json(new ApiResponse(200, suggestions, 'Autocomplete suggestions fetched'));
});

const checkAvailability = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const vehicle = await Vehicle.findOne({ _id: req.params.id, organizationId: orgId });

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  const available = vehicle.status === 'Ready for Sale';

  res.json(new ApiResponse(200, {
    available,
    status: vehicle.status,
    location: vehicle.dealerCity ? `${vehicle.dealerCity}, ${vehicle.dealerState}` : 'Unknown',
    reservedUntil: null
  }, 'Availability checked'));
});

const reserveVehicle = asyncHandler(async (req: Request, res: Response) => {
  const { customerName, duration = 24 } = req.body;
  const orgId = req.orgId as string;

  if (!customerName) {
    throw new ApiError(400, 'Customer name is required');
  }

  const vehicle = await Vehicle.findOne({ _id: req.params.id, organizationId: orgId });

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  if (vehicle.status !== 'Ready for Sale') {
    throw new ApiError(400, 'Vehicle is not available for reservation');
  }

  const userId = (req as any).user?._id;
  const reservedUntil = new Date();
  reservedUntil.setHours(reservedUntil.getHours() + duration);

  vehicle.notes.push({
    text: `Reserved for ${customerName} until ${reservedUntil.toISOString()}`,
    author: userId,
    date: new Date()
  } as any);

  await vehicle.save();

  logger.info({ vehicleId: vehicle._id, customerName, userId }, 'Vehicle reserved for customer');

  await activityService.createActivity({
    userId: userId || 'SYSTEM',
    organizationId: orgId,
    type: 'vehicle_updated',
    title: 'Vehicle Reserved',
    description: `Reserved ${vehicle.year} ${vehicle.make} ${vehicle.modelName} for ${customerName}`,
    metadata: { vehicleId: vehicle._id.toString(), customerName, reservedUntil }
  });

  res.json(new ApiResponse(200, {
    ...normalizeVehicle(vehicle),
    reservedUntil
  }, 'Vehicle reserved successfully'));
});

export default {
  createVehicle,
  getVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  addVehicleNote,
  getFilters,
  getStats,
  getDashboardGraphs,
  updateVehicleStatus,
  exportVehicles,
  getDashboard,
  autocomplete,
  checkAvailability,
  reserveVehicle,
  getPublicVehicleById,
};