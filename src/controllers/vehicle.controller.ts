import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

// Normalize vehicle data to match frontend interface
const normalizeVehicle = (vehicle: any) => ({
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName, // Frontend expects 'model'
  modelName: vehicle.modelName, // Keep for backward compatibility
  trim: vehicle.trim || '',
  color: vehicle.color || 'N/A',
  stockNumber: vehicle.stockNumber || 'N/A',
  price: vehicle.price || 0,
  marketPrice: vehicle.marketPrice || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || 'Automatic',
  fuelType: vehicle.fuelType || 'Gasoline',
  location: vehicle.location || 'Unknown',
  image: vehicle.image || 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
  status: vehicle.status,
  currentStep: vehicle.currentStep,
  reconStartDate: vehicle.reconStartDate,
  stepEnteredAt: vehicle.stepEnteredAt,
  daysOnLot: vehicle.daysOnLot || 0,
  dateAdded: vehicle.dateAdded,
  dateSold: vehicle.dateSold,
  assignedTo: vehicle.assignedTo,
  notes: vehicle.notes || [],
});

const createVehicle = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await Vehicle.create(req.body);
  res.status(201).json(
    new ApiResponse(201, normalizeVehicle(vehicle), 'Vehicle created successfully')
  );
});

const getVehicles = asyncHandler(async (req: Request, res: Response) => {
  const { status, search, make, minPrice, maxPrice } = req.query;

  // Build filter
  const filter: any = {};
  
  if (status && status !== 'all') {
    filter.status = status;
  }
  
  if (make) {
    filter.make = { $regex: make, $options: 'i' };
  }
  
  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }
  
  if (search) {
    filter.$or = [
      { vin: { $regex: search, $options: 'i' } },
      { make: { $regex: search, $options: 'i' } },
      { modelName: { $regex: search, $options: 'i' } },
      { stockNumber: { $regex: search, $options: 'i' } }
    ];
  }

  const vehicles = await Vehicle.find(filter)
    .populate('assignedTo', 'email name')
    .sort({ createdAt: -1 });
  
  const normalized = vehicles.map(normalizeVehicle);

  res.json(new ApiResponse(200, normalized, 'Vehicles fetched successfully'));
});

const getVehicleById = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await Vehicle.findById(req.params.id)
    .populate('assignedTo', 'email name');
    
  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }
  
  res.json(new ApiResponse(200, normalizeVehicle(vehicle), 'Vehicle fetched successfully'));
});

const updateVehicle = asyncHandler(async (req: Request, res: Response) => {
  //  Update stepEnteredAt when currentStep changes
  const existingVehicle = await Vehicle.findById(req.params.id);
  
  if (!existingVehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  const updateData = { ...req.body };
  
  // If currentStep is changing, update stepEnteredAt
  if (updateData.currentStep && updateData.currentStep !== existingVehicle.currentStep) {
    updateData.stepEnteredAt = new Date();
  }

  const vehicle = await Vehicle.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true, runValidators: true }
  ).populate('assignedTo', 'email name');

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }
  
  res.json(new ApiResponse(200, normalizeVehicle(vehicle), 'Vehicle updated successfully'));
});

const deleteVehicle = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await Vehicle.findByIdAndDelete(req.params.id);

  if (!vehicle) {
    throw new ApiError(404, 'Vehicle not found');
  }

  res.json(new ApiResponse(200, null, 'Vehicle deleted successfully'));
});


const addVehicleNote = asyncHandler(async (req: Request, res: Response) => {
  const { text } = req.body;
  const userId = (req as any).user?._id;

  if (!text) {
    throw new ApiError(400, 'Note text is required');
  }

  if (!userId) {
    throw new ApiError(401, 'User not authenticated');
  }

  const vehicle = await Vehicle.findByIdAndUpdate(
    req.params.id,
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

export default {
  createVehicle,
  getVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  addVehicleNote,
};