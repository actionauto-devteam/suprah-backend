import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { OwnedVehicle } from "../models/OwnedVehicle.model";
import mongoose from "mongoose";
import axios from "axios";
import Vehicle from "../models/Vehicle.model";
import storageService from "../services/storage.service";
import { SUPPORT_EMAIL } from "../utils/userMessages";

export const addOwnedVehicle = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new ApiError(401, "Your session ended. Sign in again to continue.");
    }

    const {
      vin,
      make,
      model,
      year,
      trim,
      color,
      licensePlate,
      currentMileage,
    } = req.body;

    if (!vin || !make || !model || !year) {
      throw new ApiError(400, "Enter the car's VIN, make, model and year, then save again.");
    }

    const existingVehicle = await OwnedVehicle.findOne({ userId, vin });
    if (existingVehicle) {
      throw new ApiError(400, "This car is already in My Garage.");
    }

    const vehicle = await OwnedVehicle.create({
      userId,
      vin,
      make,
      model,
      year,
      trim,
      color,
      licensePlate,
      currentMileage: currentMileage || 0,
      status: "ACTIVE",
    });

    res.status(201).json({
      success: true,
      data: {
        ...vehicle.toObject(),
        id: vehicle._id.toString(),
      },
    });
  },
);

export const getOwnedVehicles = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new ApiError(401, "Your session ended. Sign in again to continue.");
    }

    const vehicles = await OwnedVehicle.find({ userId, status: "ACTIVE" }).sort(
      { createdAt: -1 },
    );

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles.map((v) => ({
        ...v.toObject(),
        id: v._id.toString(),
      })),
    });
  },
);

export const updateOwnedVehicleMileage = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new ApiError(401, "Your session ended. Sign in again to continue.");
    }

    const { id } = req.params;
    const { currentMileage } = req.body;

    if (currentMileage === undefined || typeof currentMileage !== "number") {
      throw new ApiError(400, "Enter the car's current mileage as a number, then save again.");
    }

    const vehicle = await OwnedVehicle.findOne({ _id: id, userId });

    if (!vehicle) {
      throw new ApiError(404, "We couldn't find this car in My Garage. It may have been removed. Refresh the page.");
    }

    if (currentMileage < vehicle.currentMileage) {
      throw new ApiError(400, "The new mileage can't be lower than the last one you saved. Check the odometer and try again.");
    }

    vehicle.currentMileage = currentMileage;
    await vehicle.save();

    res.status(200).json({
      success: true,
      data: {
        ...vehicle.toObject(),
        id: vehicle._id.toString(),
      },
    });
  },
);

export const decodeVin = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    throw new ApiError(401, "Your session ended. Sign in again to continue.");
  }

  const vin = (req.params.vin || "").toUpperCase().trim();
  if (!vin || vin.length !== 17) {
    throw new ApiError(400, "A VIN has 17 letters and numbers. Check it and try again.");
  }

  try {
    const [response, matchedVehicle] = await Promise.all([
      axios.get(
        `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`,
      ),
      Vehicle.findOne({ vin }).select("mileage exteriorColor").lean(),
    ]);
    const result = response.data?.Results?.[0];

    if (!result || !result.Make) {
      throw new ApiError(404, "We couldn't find car details for this VIN. Check it, or enter the make, model and year yourself.");
    }

    res.status(200).json({
      success: true,
      data: {
        make: result.Make,
        model: result.Model,
        year: result.ModelYear,
        trim: result.Trim || result.Series || "",
        currentMileage: Number(matchedVehicle?.mileage || 0),
        color: matchedVehicle?.exteriorColor || "",
        licensePlate: "",
      },
    });
  } catch (error) {
    // "No details for this VIN" is the customer's answer, not a lookup failure.
    if (error instanceof ApiError) throw error;
    console.error("VIN Decode Error:", error);
    throw new ApiError(503, `We couldn't look up this VIN right now. Try again in a minute, or enter the make, model and year yourself. If it keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`);
  }
});

// Update vehicle details
export const updateOwnedVehicle = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new ApiError(401, "Your session ended. Sign in again to continue.");
    }

    const { id } = req.params;
    const { color, licensePlate, trim, currentMileage, images } = req.body;

    const vehicle = await OwnedVehicle.findOne({ _id: id, userId });
    if (!vehicle) {
      throw new ApiError(404, "We couldn't find this car in My Garage. It may have been removed. Refresh the page.");
    }

    if (color !== undefined) vehicle.color = color;
    if (licensePlate !== undefined) vehicle.licensePlate = licensePlate;
    if (trim !== undefined) vehicle.trim = trim;
    if (currentMileage !== undefined) {
      if (currentMileage < vehicle.currentMileage) {
        throw new ApiError(400, "The new mileage can't be lower than the last one you saved. Check the odometer and try again.");
      }
      vehicle.currentMileage = currentMileage;
    }
    if (images !== undefined) vehicle.images = images;

    await vehicle.save();

    res.status(200).json({
      success: true,
      data: {
        ...vehicle.toObject(),
        id: vehicle._id.toString(),
      },
    });
  },
);

// Upload/replace the primary vehicle photo
export const uploadOwnedVehicleImage = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new ApiError(401, "Your session ended. Sign in again to continue.");
    }

    const { id } = req.params;
    const file = req.file;
    if (!file) {
      throw new ApiError(400, "Choose a photo of your car to upload.");
    }

    const vehicle = await OwnedVehicle.findOne({ _id: id, userId });
    if (!vehicle) {
      throw new ApiError(404, "We couldn't find this car in My Garage. It may have been removed. Refresh the page.");
    }

    const previousImage = vehicle.images?.[0];
    const imageUrl = await storageService.upload(file, "vehicles");

    if (previousImage) {
      await storageService.delete(previousImage);
    }

    vehicle.images = [imageUrl, ...(vehicle.images || []).slice(1)];
    await vehicle.save();

    res.status(200).json({
      success: true,
      data: {
        ...vehicle.toObject(),
        id: vehicle._id.toString(),
      },
    });
  },
);

// Delete vehicle (soft delete or hard delete; doing hard delete for now or changing status to SOLD)
export const deleteOwnedVehicle = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new ApiError(401, "Your session ended. Sign in again to continue.");
    }

    const { id } = req.params;

    const vehicle = await OwnedVehicle.findOneAndDelete({ _id: id, userId });
    if (!vehicle) {
      throw new ApiError(404, "We couldn't find this car in My Garage. It may have been removed. Refresh the page.");
    }

    res.status(200).json({
      success: true,
      message: "Car removed from My Garage.",
      data: {},
    });
  },
);
