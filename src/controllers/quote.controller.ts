import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Quote from '../models/Quote.model';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import {
    getCoordinatesFromZip,
    calculateDistance,
    calculateRate,
    calculateETA
} from '../utils/calculations';

/**
 * Create a new shipping quote
 */
const createQuote = asyncHandler(async (req: Request, res: Response) => {
    const {
        firstName,
        lastName,
        email,
        phone,
        vehicleId,
        fromZip,
        toZip,
        fromAddress,
        toAddress,
        units = 1,
        enclosedTrailer = false,
        vehicleInoperable = false
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !phone) {
        throw new ApiError(400, 'Customer information is required');
    }

    if (!fromZip || !toZip || !fromAddress || !toAddress) {
        throw new ApiError(400, 'Shipping addresses are required');
    }

    // Validate ZIP codes
    const zipRegex = /^\d{5}(-\d{4})?$/;
    if (!zipRegex.test(fromZip) || !zipRegex.test(toZip)) {
        throw new ApiError(400, 'Invalid ZIP code format');
    }

    // Get vehicle details if vehicleId is provided
    let vehicleData: any = {};
    if (vehicleId) {
        const vehicle = await Vehicle.findById(vehicleId);
        if (vehicle) {
            vehicleData = {
                vehicleId: vehicle._id,
                vehicleName: `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`,
                vin: vehicle.vin,
                stockNumber: vehicle.stockNumber,
                vehiclePrice: vehicle.price,
                vehicleMarketPrice: vehicle.msrp,
                vehicleLocation: vehicle.dealerCity ? `${vehicle.dealerCity}, ${vehicle.dealerState}` : 'Unknown',
                vehicleImage: (vehicle.images && vehicle.images.length > 0) ? vehicle.images[0] : 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
                vehicleStatus: vehicle.status,
                daysOnLot: vehicle.daysOnLot
            };
        }
    }

    // Get coordinates for distance calculation
    const fromCoords = await getCoordinatesFromZip(fromZip);
    if (!fromCoords) {
        throw new ApiError(400, 'Invalid origin ZIP code');
    }

    const toCoords = await getCoordinatesFromZip(toZip);
    if (!toCoords) {
        throw new ApiError(400, 'Invalid destination ZIP code');
    }

    // Calculate shipping details
    const miles = calculateDistance(
        fromCoords.lat,
        fromCoords.lon,
        toCoords.lat,
        toCoords.lon
    );
    const rate = calculateRate(miles, units, enclosedTrailer, vehicleInoperable);
    const eta = calculateETA(miles);

    // Create quote
    const quote = await Quote.create({
        firstName,
        lastName,
        email,
        phone,
        ...vehicleData,
        fromZip,
        toZip,
        fromAddress,
        toAddress,
        units,
        enclosedTrailer,
        vehicleInoperable,
        miles,
        rate,
        eta,
        status: 'pending'
    });

    // Populate vehicle details in response
    const populatedQuote = await Quote.findById(quote._id)
        .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    res.status(201).json(
        new ApiResponse(201, populatedQuote, 'Quote created successfully')
    );
});

/**
 * Get all quotes
 */
const getQuotes = asyncHandler(async (req: Request, res: Response) => {
    const { status, search } = req.query;

    const filter: any = {};

    if (status && status !== 'all') {
        filter.status = status;
    }

    if (search) {
        filter.$or = [
            { firstName: { $regex: search, $options: 'i' } },
            { lastName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { vin: { $regex: search, $options: 'i' } },
            { stockNumber: { $regex: search, $options: 'i' } }
        ];
    }

    const quotes = await Quote.find(filter)
        .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState')
        .sort({ createdAt: -1 });

    res.json(new ApiResponse(200, quotes, 'Quotes fetched successfully'));
});

/**
 * Get quote by ID
 */
const getQuoteById = asyncHandler(async (req: Request, res: Response) => {
    const quote = await Quote.findById(req.params.id)
        .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    res.json(new ApiResponse(200, quote, 'Quote fetched successfully'));
});

/**
 * Update quote - FULL UPDATE
 * This replaces the old updateQuoteStatus to support updating all fields
 */
const updateQuote = asyncHandler(async (req: Request, res: Response) => {
    const {
        firstName,
        lastName,
        email,
        phone,
        fromZip,
        toZip,
        fromAddress,
        toAddress,
        units,
        enclosedTrailer,
        vehicleInoperable,
        vehicleName,
        vin,
        stockNumber,
        vehicleLocation,
        rate,
        miles,
        eta,
        status
    } = req.body;

    // Build update object with only provided fields
    const updateData: any = {};

    // Customer information
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;

    // Vehicle information
    if (vehicleName !== undefined) updateData.vehicleName = vehicleName;
    if (vin !== undefined) updateData.vin = vin;
    if (stockNumber !== undefined) updateData.stockNumber = stockNumber;
    if (vehicleLocation !== undefined) updateData.vehicleLocation = vehicleLocation;

    // Shipping information
    if (fromZip !== undefined) updateData.fromZip = fromZip;
    if (toZip !== undefined) updateData.toZip = toZip;
    if (fromAddress !== undefined) updateData.fromAddress = fromAddress;
    if (toAddress !== undefined) updateData.toAddress = toAddress;
    if (units !== undefined) updateData.units = units;
    if (enclosedTrailer !== undefined) updateData.enclosedTrailer = enclosedTrailer;
    if (vehicleInoperable !== undefined) updateData.vehicleInoperable = vehicleInoperable;

    // Calculated fields
    if (rate !== undefined) updateData.rate = rate;
    if (miles !== undefined) updateData.miles = miles;
    if (eta !== undefined) updateData.eta = eta;

    // Status
    if (status !== undefined) {
        const validStatuses = ['pending', 'accepted', 'rejected', 'booked'];
        if (!validStatuses.includes(status)) {
            throw new ApiError(400, 'Invalid status');
        }
        updateData.status = status;
    }

    // If ZIP codes changed, recalculate distance and rate
    if ((fromZip && toZip) || (updateData.fromZip && updateData.toZip)) {
        const quote = await Quote.findById(req.params.id);
        if (!quote) {
            throw new ApiError(404, 'Quote not found');
        }

        const finalFromZip = fromZip || quote.fromZip;
        const finalToZip = toZip || quote.toZip;
        const finalUnits = units !== undefined ? units : quote.units;
        const finalEnclosed = enclosedTrailer !== undefined ? enclosedTrailer : quote.enclosedTrailer;
        const finalInoperable = vehicleInoperable !== undefined ? vehicleInoperable : quote.vehicleInoperable;

        try {
            const fromCoords = await getCoordinatesFromZip(finalFromZip);
            const toCoords = await getCoordinatesFromZip(finalToZip);

            if (fromCoords && toCoords) {
                const newMiles = calculateDistance(
                    fromCoords.lat,
                    fromCoords.lon,
                    toCoords.lat,
                    toCoords.lon
                );
                const newRate = calculateRate(newMiles, finalUnits, finalEnclosed, finalInoperable);
                const newEta = calculateETA(newMiles);

                updateData.miles = newMiles;
                updateData.rate = newRate;
                updateData.eta = newEta;
            }
        } catch (error) {
            console.error('Error recalculating shipping details:', error);
            // Continue with update even if calculation fails
        }
    }

    const quote = await Quote.findByIdAndUpdate(
        req.params.id,
        updateData,
        { new: true, runValidators: true }
    ).populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    res.json(new ApiResponse(200, quote, 'Quote updated successfully'));
});


/**
 * Update quote status (kept for backward compatibility)
 */
const updateQuoteStatus = asyncHandler(async (req: Request, res: Response) => {
    const { status } = req.body;

    const validStatuses = ['pending', 'accepted', 'rejected', 'booked'];
    if (!validStatuses.includes(status)) {
        throw new ApiError(400, 'Invalid status');
    }

    const quote = await Quote.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
    ).populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    res.json(new ApiResponse(200, quote, 'Quote status updated successfully'));
});

/**
 * Delete quote
 */
const deleteQuote = asyncHandler(async (req: Request, res: Response) => {
    const quote = await Quote.findByIdAndDelete(req.params.id);

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    res.json(new ApiResponse(200, null, 'Quote deleted successfully'));
});

export default {
    createQuote,
    getQuotes,
    getQuoteById,
    updateQuote,
    updateQuoteStatus,
    deleteQuote
};