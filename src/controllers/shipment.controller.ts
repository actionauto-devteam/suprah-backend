import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Shipment from '../models/Shipment.model';
import Quote from '../models/Quote.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

/**
 * Create a new shipment from a quote
 */
const createShipment = asyncHandler(async (req: Request, res: Response) => {
    const { quoteId, requestedPickupDate } = req.body;

    if (!quoteId) {
        throw new ApiError(400, 'Quote ID is required');
    }

    const quote = await Quote.findById(quoteId)
        .populate('vehicleId', 'year make modelName vin stockNumber image location');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    // Check if shipment already exists for this quote
    const existingShipment = await Shipment.findOne({ quoteId });
    if (existingShipment) {
        throw new ApiError(400, 'Shipment already exists for this quote');
    }

    // Create shipment
    const shipment = await Shipment.create({
        quoteId,
        status: 'Available for Pickup',
        origin: quote.fromAddress,
        destination: quote.toAddress,
        requestedPickupDate: requestedPickupDate || new Date()
    });


    await Quote.findByIdAndUpdate(quoteId, { status: 'booked' });


    const populatedShipment = await Shipment.findById(shipment._id)
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        });

    res.status(201).json(
        new ApiResponse(201, populatedShipment, 'Shipment created successfully')
    );
});

/**
 * Get all shipments
 */
const getShipments = asyncHandler(async (req: Request, res: Response) => {
    const { status, search } = req.query;

    const filter: any = {};

    if (status && status !== 'all') {
        filter.status = status;
    }

    // FIXED: Properly populate nested data
    const shipments = await Shipment.find(filter)
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        })
        .sort({ createdAt: -1 });

    // Apply search filter if provided
    let filteredShipments = shipments;
    if (search) {
        const searchLower = (search as string).toLowerCase();
        filteredShipments = shipments.filter(shipment => {
            const quote = shipment.quoteId as any;
            return (
                quote?.firstName?.toLowerCase().includes(searchLower) ||
                quote?.lastName?.toLowerCase().includes(searchLower) ||
                quote?.vin?.toLowerCase().includes(searchLower) ||
                quote?.stockNumber?.toLowerCase().includes(searchLower) ||
                shipment.trackingNumber?.toLowerCase().includes(searchLower)
            );
        });
    }

    res.json(new ApiResponse(200, filteredShipments, 'Shipments fetched successfully'));
});

/**
 * Get shipment by ID
 */
const getShipmentById = asyncHandler(async (req: Request, res: Response) => {
    const shipment = await Shipment.findById(req.params.id)
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        });

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
    }

    res.json(new ApiResponse(200, shipment, 'Shipment fetched successfully'));
});

/**
 * Update shipment status and dates
 */
const updateShipment = asyncHandler(async (req: Request, res: Response) => {
    const {
        status,
        scheduledPickup,
        pickedUp,
        scheduledDelivery,
        delivered,
        trackingNumber,
        carrierInfo
    } = req.body;

    const updateData: any = {};

    if (status) {
        const validStatuses = [
            'Available for Pickup',
            'Cancelled',
            'Delivered',
            'Dispatched',
            'In-Route'
        ];
        if (!validStatuses.includes(status)) {
            throw new ApiError(400, 'Invalid status');
        }
        updateData.status = status;
    }

    if (scheduledPickup) updateData.scheduledPickup = new Date(scheduledPickup);
    if (pickedUp) updateData.pickedUp = new Date(pickedUp);
    if (scheduledDelivery) updateData.scheduledDelivery = new Date(scheduledDelivery);
    if (delivered) updateData.delivered = new Date(delivered);
    if (trackingNumber) updateData.trackingNumber = trackingNumber;
    if (carrierInfo) updateData.carrierInfo = carrierInfo;

    const shipment = await Shipment.findByIdAndUpdate(
        req.params.id,
        updateData,
        { new: true, runValidators: true }
    ).populate({
        path: 'quoteId',
        populate: {
            path: 'vehicleId',
            select: 'year make modelName vin stockNumber image location'
        }
    });

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
    }

    res.json(new ApiResponse(200, shipment, 'Shipment updated successfully'));
});

/**
 * Add note to shipment
 */
const addShipmentNote = asyncHandler(async (req: Request, res: Response) => {
    const { text } = req.body;
    const userId = (req as any).user?._id;

    if (!text) {
        throw new ApiError(400, 'Note text is required');
    }

    if (!userId) {
        throw new ApiError(401, 'User not authenticated');
    }

    const shipment = await Shipment.findByIdAndUpdate(
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
    ).populate({
        path: 'quoteId',
        populate: {
            path: 'vehicleId',
            select: 'year make modelName vin stockNumber image location'
        }
    }).populate('notes.author', 'name email');

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
    }

    res.json(new ApiResponse(200, shipment, 'Note added successfully'));
});

/**
 * Delete shipment
 */
const deleteShipment = asyncHandler(async (req: Request, res: Response) => {
    const shipment = await Shipment.findByIdAndDelete(req.params.id);

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
    }

    // Update quote status back to accepted
    await Quote.findByIdAndUpdate(shipment.quoteId, { status: 'accepted' });

    res.json(new ApiResponse(200, null, 'Shipment deleted successfully'));
});

/**
 * Get shipment statistics
 */
const getShipmentStats = asyncHandler(async (req: Request, res: Response) => {
    const stats = await Shipment.aggregate([
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);

    const formattedStats: any = {
        all: 0,
        'Available for Pickup': 0,
        'Cancelled': 0,
        'Delivered': 0,
        'Dispatched': 0,
        'In-Route': 0
    };

    stats.forEach(stat => {
        if (formattedStats.hasOwnProperty(stat._id)) {
            formattedStats[stat._id] = stat.count;
            formattedStats.all += stat.count;
        }
    });

    res.json(new ApiResponse(200, formattedStats, 'Statistics fetched successfully'));
});

export default {
    createShipment,
    getShipments,
    getShipmentById,
    updateShipment,
    addShipmentNote,
    deleteShipment,
    getShipmentStats
};