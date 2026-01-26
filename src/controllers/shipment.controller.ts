import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Shipment from '../models/Shipment.model';
import Quote from '../models/Quote.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

/**
 * Generate a unique tracking number
 * Format: TRK-YYYYMMDD-XXXX (e.g., TRK-20260127-A3F9)
 */
const generateTrackingNumber = async (): Promise<string> => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const datePrefix = `${year}${month}${day}`;
    
    // Generate random alphanumeric code
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let trackingNumber: string;
    let isUnique = false;
    
    // Keep generating until we get a unique number
    while (!isUnique) {
        let randomCode = '';
        for (let i = 0; i < 4; i++) {
            randomCode += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        
        trackingNumber = `TRK-${datePrefix}-${randomCode}`;
        
        // Check if tracking number already exists
        const existing = await Shipment.findOne({ trackingNumber });
        if (!existing) {
            isUnique = true;
        }
    }
    
    return trackingNumber!;
};

/**
 * Create a new shipment from a quote
 * This will automatically delete the quote after creating the shipment
 */
const createShipment = asyncHandler(async (req: Request, res: Response) => {
    const { quoteId, requestedPickupDate, autoDeleteQuote = true } = req.body;

    if (!quoteId) {
        throw new ApiError(400, 'Quote ID is required');
    }

    const quote = await Quote.findById(quoteId)
        .populate('vehicleId', 'year make modelName vin stockNumber image location');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    const existingShipment = await Shipment.findOne({ quoteId });
    if (existingShipment) {
        throw new ApiError(400, 'Shipment already exists for this quote');
    }

    if (quote.status === 'booked') {
        throw new ApiError(400, 'This quote has already been converted to a shipment');
    }

    // Generate unique tracking number
    const trackingNumber = await generateTrackingNumber();

    const shipment = await Shipment.create({
        quoteId,
        status: 'Available for Pickup',
        origin: quote.fromAddress,
        destination: quote.toAddress,
        requestedPickupDate: requestedPickupDate || new Date(),
        trackingNumber, // Add the generated tracking number
        preservedQuoteData: {
            firstName: quote.firstName,
            lastName: quote.lastName,
            email: quote.email,
            phone: quote.phone,
            vehicleName: quote.vehicleName,
            vehicleImage: quote.vehicleImage,
            vin: quote.vin,
            stockNumber: quote.stockNumber,
            fromZip: quote.fromZip,
            toZip: quote.toZip,
            fromAddress: quote.fromAddress,
            toAddress: quote.toAddress,
            miles: quote.miles,
            rate: quote.rate,
            eta: quote.eta,
            enclosedTrailer: quote.enclosedTrailer,
            vehicleInoperable: quote.vehicleInoperable,
            units: quote.units
        }
    });

    const populatedShipment = await Shipment.findById(shipment._id)
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        });

    if (autoDeleteQuote) {
        await Quote.findByIdAndDelete(quoteId);
    } else {
        await Quote.findByIdAndUpdate(quoteId, { status: 'booked' });
    }

    res.status(201).json(
        new ApiResponse(
            201, 
            populatedShipment, 
            autoDeleteQuote 
                ? 'Shipment created successfully. Quote has been removed.' 
                : 'Shipment created successfully.'
        )
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

    const shipments = await Shipment.find(filter)
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        })
        .sort({ createdAt: -1 });

    let filteredShipments = shipments;
    if (search) {
        const searchLower = (search as string).toLowerCase();
        filteredShipments = shipments.filter(shipment => {
            const quote = shipment.quoteId as any;
            const preserved = shipment.preservedQuoteData as any;
            
            return (
                quote?.firstName?.toLowerCase().includes(searchLower) ||
                quote?.lastName?.toLowerCase().includes(searchLower) ||
                quote?.vin?.toLowerCase().includes(searchLower) ||
                quote?.stockNumber?.toLowerCase().includes(searchLower) ||
                preserved?.firstName?.toLowerCase().includes(searchLower) ||
                preserved?.lastName?.toLowerCase().includes(searchLower) ||
                preserved?.vin?.toLowerCase().includes(searchLower) ||
                preserved?.stockNumber?.toLowerCase().includes(searchLower) ||
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
 * Update shipment - ENHANCED to support all fields
 * NOTE: trackingNumber is NOT included as it should never be modified
 */
const updateShipment = asyncHandler(async (req: Request, res: Response) => {
    const {
        status,
        origin,
        destination,
        requestedPickupDate,
        scheduledPickup,
        pickedUp,
        scheduledDelivery,
        delivered,
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

    // Route information
    if (origin !== undefined) updateData.origin = origin;
    if (destination !== undefined) updateData.destination = destination;

    // Dates - handle both string dates and null/undefined
    if (requestedPickupDate !== undefined) {
        updateData.requestedPickupDate = requestedPickupDate ? new Date(requestedPickupDate) : null;
    }
    if (scheduledPickup !== undefined) {
        updateData.scheduledPickup = scheduledPickup ? new Date(scheduledPickup) : null;
    }
    if (pickedUp !== undefined) {
        updateData.pickedUp = pickedUp ? new Date(pickedUp) : null;
    }
    if (scheduledDelivery !== undefined) {
        updateData.scheduledDelivery = scheduledDelivery ? new Date(scheduledDelivery) : null;
    }
    if (delivered !== undefined) {
        updateData.delivered = delivered ? new Date(delivered) : null;
    }
    
    // Carrier info (trackingNumber is intentionally excluded)
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
 * This will restore the quote if it was deleted during shipment creation
 */
const deleteShipment = asyncHandler(async (req: Request, res: Response) => {
    const shipment = await Shipment.findById(req.params.id);

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
    }

    const existingQuote = await Quote.findById(shipment.quoteId);
    
    if (existingQuote) {
        await Quote.findByIdAndUpdate(shipment.quoteId, { status: 'accepted' });
    } else if (shipment.preservedQuoteData) {
        const preserved = shipment.preservedQuoteData as any;
        await Quote.create({
            _id: shipment.quoteId,
            firstName: preserved.firstName,
            lastName: preserved.lastName,
            email: preserved.email,
            phone: preserved.phone,
            vehicleName: preserved.vehicleName,
            vehicleImage: preserved.vehicleImage,
            vin: preserved.vin,
            stockNumber: preserved.stockNumber,
            fromZip: preserved.fromZip,
            toZip: preserved.toZip,
            fromAddress: preserved.fromAddress,
            toAddress: preserved.toAddress,
            miles: preserved.miles,
            rate: preserved.rate,
            eta: preserved.eta,
            enclosedTrailer: preserved.enclosedTrailer,
            vehicleInoperable: preserved.vehicleInoperable,
            units: preserved.units,
            status: 'accepted',
            vehicleId: preserved.vehicleId
        });
    }

    await Shipment.findByIdAndDelete(req.params.id);

    res.json(
        new ApiResponse(
            200, 
            null, 
            existingQuote 
                ? 'Shipment deleted successfully. Quote status updated to accepted.' 
                : 'Shipment deleted successfully. Quote has been restored.'
        )
    );
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