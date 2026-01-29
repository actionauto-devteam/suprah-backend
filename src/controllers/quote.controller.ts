import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Quote from '../models/Quote.model';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { IUser } from '../models/User.model';
import {
    getCoordinatesFromZip,
    calculateDistance,
    calculateRate,
    calculateETA
} from '../utils/calculations';

/**
 * Helper to safely get user ID from request
 */
const getUserId = (req: Request): string | undefined => {
  return (req.user as IUser)?._id?.toString();
};

/**
 * Create a new shipping quote
 */
const createQuote = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
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

    if (!firstName || !lastName || !email || !phone) {
        throw new ApiError(400, 'Customer information is required');
    }

    if (!fromZip || !toZip || !fromAddress || !toAddress) {
        throw new ApiError(400, 'Shipping addresses are required');
    }

    const zipRegex = /^\d{5}(-\d{4})?$/;
    if (!zipRegex.test(fromZip) || !zipRegex.test(toZip)) {
        throw new ApiError(400, 'Invalid ZIP code format');
    }

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

    const fromCoords = await getCoordinatesFromZip(fromZip);
    if (!fromCoords) {
        throw new ApiError(400, 'Invalid origin ZIP code');
    }

    const toCoords = await getCoordinatesFromZip(toZip);
    if (!toCoords) {
        throw new ApiError(400, 'Invalid destination ZIP code');
    }

    const miles = calculateDistance(
        fromCoords.lat,
        fromCoords.lon,
        toCoords.lat,
        toCoords.lon
    );
    const rate = calculateRate(miles, units, enclosedTrailer, vehicleInoperable);
    const eta = calculateETA(miles);

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

    const populatedQuote = await Quote.findById(quote._id)
        .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.quote_created({
            customerName: `${firstName} ${lastName}`,
            vehicleName: vehicleData.vehicleName,
            rate,
        });

        await safeCreateNotification({
            userId,
            type: 'quote_created',
            title,
            message,
            metadata: {
                quoteId: quote._id.toString(),
                customerName: `${firstName} ${lastName}`,
                vehicleName: vehicleData.vehicleName,
                rate,
            },
        });
    }

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
 */
const updateQuote = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
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

    const updateData: any = {};

    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (vehicleName !== undefined) updateData.vehicleName = vehicleName;
    if (vin !== undefined) updateData.vin = vin;
    if (stockNumber !== undefined) updateData.stockNumber = stockNumber;
    if (vehicleLocation !== undefined) updateData.vehicleLocation = vehicleLocation;
    if (fromZip !== undefined) updateData.fromZip = fromZip;
    if (toZip !== undefined) updateData.toZip = toZip;
    if (fromAddress !== undefined) updateData.fromAddress = fromAddress;
    if (toAddress !== undefined) updateData.toAddress = toAddress;
    if (units !== undefined) updateData.units = units;
    if (enclosedTrailer !== undefined) updateData.enclosedTrailer = enclosedTrailer;
    if (vehicleInoperable !== undefined) updateData.vehicleInoperable = vehicleInoperable;
    if (rate !== undefined) updateData.rate = rate;
    if (miles !== undefined) updateData.miles = miles;
    if (eta !== undefined) updateData.eta = eta;

    if (status !== undefined) {
        const validStatuses = ['pending', 'accepted', 'rejected', 'booked'];
        if (!validStatuses.includes(status)) {
            throw new ApiError(400, 'Invalid status');
        }
        updateData.status = status;
    }

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

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.quote_updated({
            customerName: `${quote.firstName} ${quote.lastName}`,
            vehicleName: quote.vehicleName,
        });

        await safeCreateNotification({
            userId,
            type: 'quote_updated',
            title,
            message,
            metadata: {
                quoteId: quote._id.toString(),
                customerName: `${quote.firstName} ${quote.lastName}`,
                vehicleName: quote.vehicleName,
            },
        });
    }

    res.json(new ApiResponse(200, quote, 'Quote updated successfully'));
});

/**
 * Update quote status (kept for backward compatibility)
 */
const updateQuoteStatus = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
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

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.quote_updated({
            customerName: `${quote.firstName} ${quote.lastName}`,
        });

        await safeCreateNotification({
            userId,
            type: 'quote_updated',
            title: 'Quote Status Updated',
            message: `Quote status changed to ${status} for ${quote.firstName} ${quote.lastName}`,
            metadata: {
                quoteId: quote._id.toString(),
                customerName: `${quote.firstName} ${quote.lastName}`,
                status,
            },
        });
    }

    res.json(new ApiResponse(200, quote, 'Quote status updated successfully'));
});

/**
 * Delete quote
 */
const deleteQuote = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const quote = await Quote.findById(req.params.id);

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    const customerName = `${quote.firstName} ${quote.lastName}`;
    const vehicleName = quote.vehicleName;

    await Quote.findByIdAndDelete(req.params.id);

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.quote_deleted({
            customerName,
            vehicleName,
        });

        await safeCreateNotification({
            userId,
            type: 'quote_deleted',
            title,
            message,
            metadata: {
                customerName,
                vehicleName,
            },
        });
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