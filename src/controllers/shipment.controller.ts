// shipment.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Shipment from '../models/Shipment.model';
import Quote from '../models/Quote.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

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

    // Check if shipment already exists for this quote
    const existingShipment = await Shipment.findOne({ quoteId });
    if (existingShipment) {
        throw new ApiError(400, 'Shipment already exists for this quote');
    }

    // Check if quote is already booked by another shipment
    if (quote.status === 'booked') {
        throw new ApiError(400, 'This quote has already been converted to a shipment');
    }

    // Create shipment with all quote data embedded to preserve information
    const shipment = await Shipment.create({
        quoteId,
        status: 'Available for Pickup',
        origin: quote.fromAddress,
        destination: quote.toAddress,
        requestedPickupDate: requestedPickupDate || new Date(),
        // Store quote data for reference even after quote deletion
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

    // Populate the shipment before deletion/update of quote
    const populatedShipment = await Shipment.findById(shipment._id)
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        });

    // Delete quote if autoDeleteQuote is true (default behavior)
    if (autoDeleteQuote) {
        await Quote.findByIdAndDelete(quoteId);
    } else {
        // Otherwise just mark as booked
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

    // Properly populate nested data
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
            const preserved = shipment.preservedQuoteData as any;
            
            return (
                // Search in quote data (if quote still exists)
                quote?.firstName?.toLowerCase().includes(searchLower) ||
                quote?.lastName?.toLowerCase().includes(searchLower) ||
                quote?.vin?.toLowerCase().includes(searchLower) ||
                quote?.stockNumber?.toLowerCase().includes(searchLower) ||
                // Search in preserved data (if quote was deleted)
                preserved?.firstName?.toLowerCase().includes(searchLower) ||
                preserved?.lastName?.toLowerCase().includes(searchLower) ||
                preserved?.vin?.toLowerCase().includes(searchLower) ||
                preserved?.stockNumber?.toLowerCase().includes(searchLower) ||
                // Search in tracking number
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
 * This will restore the quote if it was deleted during shipment creation
 */
const deleteShipment = asyncHandler(async (req: Request, res: Response) => {
    const shipment = await Shipment.findById(req.params.id);

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
    }

    // Check if the quote still exists
    const existingQuote = await Quote.findById(shipment.quoteId);
    
    if (existingQuote) {
        // Quote exists, just update its status back to accepted
        await Quote.findByIdAndUpdate(shipment.quoteId, { status: 'accepted' });
    } else if (shipment.preservedQuoteData) {
        // Quote was deleted, restore it from preserved data
        const preserved = shipment.preservedQuoteData as any;
        await Quote.create({
            _id: shipment.quoteId, // Restore with original ID
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
            status: 'accepted', // Set status to accepted when restoring
            vehicleId: preserved.vehicleId
        });
    }

    // Delete the shipment
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