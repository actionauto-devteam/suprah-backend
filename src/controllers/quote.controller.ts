import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import Quote from '../models/Quote.model';
import Load from '../models/Load.model';
import Vehicle from '../models/Vehicle.model';
import Organization from '../models/Organization.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { safeCreateNotification, notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { IUser } from '../models/User.model';
import cacheService from '../services/cache.service';
import { getSocketIO } from '../utils/socketEmitter';
import {
    getCoordinatesFromZip,
    calculateDistance,
    calculateRate,
    calculateETA
} from '../utils/calculations';

const QUOTE_CACHE_TTL = 60 * 5;

const getUserId = (req: Request): string | undefined => {
    return (req.user as IUser)?._id?.toString();
};

const createQuote = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const {
        firstName,
        lastName,
        email,
        phone,
        vehicleId,
        vehicleName,
        vin,
        stockNumber,
        vehiclePrice,
        vehicleMarketPrice,
        vehicleLocation,
        vehicleImage,
        vehicleStatus,
        daysOnLot,
        fromZip,
        toZip,
        fromAddress,
        toAddress,
        units = 1,
        enclosedTrailer = false,
        vehicleInoperable = false
    } = req.body;
    const orgId = req.orgId as string;

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

    /*
     * A quote may come from:
     * 1. Inventory, with a real MongoDB Vehicle ObjectId.
     * 2. CRM Leads, with only a vehicle snapshot and a stock number.
     *
     * Preserve the request snapshot first. If a valid inventory vehicle is
     * found, replace those values with the authoritative database values.
     */
    let vehicleData: any = {
        ...(vehicleName && { vehicleName: String(vehicleName).trim() }),
        ...(vin && { vin: String(vin).trim() }),
        ...(stockNumber && { stockNumber: String(stockNumber).trim() }),
        ...(vehiclePrice !== undefined && {
            vehiclePrice: Number(vehiclePrice),
        }),
        ...(vehicleMarketPrice !== undefined && {
            vehicleMarketPrice: Number(vehicleMarketPrice),
        }),
        ...(vehicleLocation && {
            vehicleLocation: String(vehicleLocation).trim(),
        }),
        ...(vehicleImage && {
            vehicleImage: String(vehicleImage).trim(),
        }),
        ...(vehicleStatus && {
            vehicleStatus: String(vehicleStatus).trim(),
        }),
        ...(daysOnLot !== undefined && {
            daysOnLot: Number(daysOnLot),
        }),
    };

    if (vehicleId) {
        const normalizedVehicleId = String(vehicleId).trim();

        if (mongoose.Types.ObjectId.isValid(normalizedVehicleId)) {
            const vehicle = await Vehicle.findById(normalizedVehicleId);

            if (vehicle) {
                vehicleData = {
                    ...vehicleData,
                    vehicleId: vehicle._id,
                    vehicleName: `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`,
                    vin: vehicle.vin || vehicleData.vin,
                    stockNumber: vehicle.stockNumber || vehicleData.stockNumber,
                    vehiclePrice: vehicle.price ?? vehicleData.vehiclePrice,
                    vehicleMarketPrice:
                        vehicle.msrp ?? vehicleData.vehicleMarketPrice,
                    vehicleLocation: vehicle.dealerCity
                        ? `${vehicle.dealerCity}, ${vehicle.dealerState}`
                        : vehicleData.vehicleLocation || 'Unknown',
                    vehicleImage:
                        vehicle.images && vehicle.images.length > 0
                            ? vehicle.images[0]
                            : vehicleData.vehicleImage ||
                              'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
                    vehicleStatus:
                        vehicle.status || vehicleData.vehicleStatus,
                    daysOnLot:
                        vehicle.daysOnLot ?? vehicleData.daysOnLot,
                };
            }
        } else {
            logger.warn(
                {
                    vehicleId: normalizedVehicleId,
                    stockNumber: vehicleData.stockNumber,
                    vin: vehicleData.vin,
                },
                'Quote received a non-ObjectId vehicle reference; using the CRM vehicle snapshot',
            );
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
        status: 'pending',
        organizationId: orgId,
        ...(userId && { createdBy: userId })
    });

    const populatedQuote = await Quote.findById(quote._id)
        .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState')
        .populate('createdBy', 'name email avatar');

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.quote_created({
            customerName: `${firstName} ${lastName}`,
            vehicleName: vehicleData.vehicleName,
            rate,
        });

        await safeCreateNotification({
            userId,
            organizationId: orgId,
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

    notifyOrgAdmins(
        orgId,
        'quote_created',
        'New Draft Created',
        `A new transportation draft has been created for ${firstName} ${lastName} — ${vehicleData.vehicleName}.`,
        { quoteId: quote._id.toString(), customerName: `${firstName} ${lastName}`, vehicleName: vehicleData.vehicleName }
    );

    res.status(201).json(
        new ApiResponse(201, populatedQuote, 'Quote created successfully')
    );

    // Real-time: notify org members
    const _ioC = getSocketIO();
    if (_ioC) _ioC.to(`org:${orgId}`).emit('quote:change', { action: 'created' });

    // Invalidate quote cache after creation
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);

    await activityService.createActivity({
        userId: userId || 'GUEST',
        organizationId: orgId,
        type: 'quote_created',
        title: 'Draft Created',
        description: `New transportation draft created for ${firstName} ${lastName}`,
        metadata: { quoteId: quote._id.toString(), vehicleName: vehicleData.vehicleName, rate },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
    });

    logger.info({ quoteId: quote._id, orgId }, 'New shipping quote created');
});

/**
 * Get all quotes (cross-org — all orgs visible for transparency)
 */
const getQuotes = asyncHandler(async (req: Request, res: Response) => {
    const { status, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const orgId = req.orgId as string;

    const filter: any = {
        organizationId: orgId,
    };
    if (status && status !== 'all') {
        filter.status = status;
    }
    if (search) {
        filter.$or = [
            { firstName: { $regex: search, $options: 'i' } },
            { lastName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { vin: { $regex: search, $options: 'i' } },
            { stockNumber: { $regex: search, $options: 'i' } },
        ];
    }

    const isCacheable = !search;
    const cacheKey = `quotes:${orgId}:list:${status || 'all'}:p${page}:l${limit}`;

    if (isCacheable) {
        const cached = await cacheService.get(cacheKey);
        if (cached) {
            return res.json(new ApiResponse(200, cached, 'Quotes fetched successfully'));
        }
    }

    const [total, quotes] = await Promise.all([
        Quote.countDocuments(filter),
        Quote.find(filter)
            .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState')
            .populate('createdBy', 'name email avatar')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
    ]);

    // Attach organization name to each quote
    const uniqueOrgIds = [...new Set(quotes.map(q => q.organizationId).filter(Boolean))]
        .filter(id => /^[0-9a-fA-F]{24}$/.test(String(id)));
    const orgs = await Organization.find({ _id: { $in: uniqueOrgIds } }).select('name logoUrl');
    const orgMap = new Map<string, { name: string; logoUrl?: string }>();
    orgs.forEach(o => orgMap.set(o._id.toString(), { name: o.name, logoUrl: o.logoUrl }));

    const quotesWithOrg = quotes.map(q => ({
        ...(q.toJSON()),
        organization: orgMap.get(q.organizationId) || { name: 'Unknown Org' },
    }));

    const totalPages = Math.ceil(total / limit);
    const responseData = {
        quotes: quotesWithOrg,
        pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    };

    if (isCacheable) {
        await cacheService.set(cacheKey, responseData, QUOTE_CACHE_TTL);
    }

    res.json(new ApiResponse(200, responseData, 'Quotes fetched successfully'));
});

/**
 * Get quote by ID
 */
const getQuoteById = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const quote = await Quote.findOne({ _id: req.params.id, organizationId: orgId })
        .populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState')
        .populate('createdBy', 'name email avatar');

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
    const orgId = req.orgId as string;
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
        const quote = await Quote.findOne({ _id: req.params.id, organizationId: orgId });
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

    const quote = await Quote.findOneAndUpdate(
        { _id: req.params.id, organizationId: orgId },
        updateData,
        { new: true, runValidators: true }
    ).populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    // Create notification safely
    if (userId || status === 'accepted') {
        const nType = status === 'accepted' ? 'quote_accepted' : 'quote_updated';
        const { title, message } = notificationTemplates[nType]({
            customerName: `${quote.firstName} ${quote.lastName}`,
            vehicleName: quote.vehicleName,
        });

        if (userId) {
            await safeCreateNotification({
                userId,
                organizationId: orgId,
                type: nType,
                title,
                message,
                metadata: {
                    quoteId: quote._id.toString(),
                    customerName: `${quote.firstName} ${quote.lastName}`,
                    vehicleName: quote.vehicleName,
                    status: quote.status,
                },
            });
        }

        // If it was accepted, also broadcast to the whole org
        if (status === 'accepted') {
            await notifyOrgAdmins(
                orgId,
                'quote_accepted',
                title,
                message,
                { quoteId: quote._id.toString(), customerName: `${quote.firstName} ${quote.lastName}` }
            );
        }
    }

    res.json(new ApiResponse(200, quote, 'Quote updated successfully'));

    // Real-time: notify org members
    const _ioU = getSocketIO();
    if (_ioU) _ioU.to(`org:${orgId}`).emit('quote:change', { action: 'updated' });

    // Invalidate quote cache on update
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);

    await activityService.createActivity({
        userId: userId || 'SYSTEM',
        organizationId: orgId,
        type: 'quote_updated',
        title: 'Draft Updated',
        description: `Quote details modified for ${quote.firstName} ${quote.lastName}`,
        metadata: { quoteId: quote._id.toString(), status: quote.status },
        ipAddress: req.ip
    });

    logger.info({ quoteId: quote._id, orgId }, 'Quote details updated');
});

/**
 * Update quote status (kept for backward compatibility)
 */
const updateQuoteStatus = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const orgId = req.orgId as string;
    const { status } = req.body;

    const validStatuses = ['pending', 'accepted', 'rejected', 'booked'];
    if (!validStatuses.includes(status)) {
        throw new ApiError(400, 'Invalid status');
    }

    const quote = await Quote.findOneAndUpdate(
        { _id: req.params.id, organizationId: orgId },
        { status },
        { new: true }
    ).populate('vehicleId', 'year make modelName vin stockNumber images dealerCity dealerState');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    // Create notification safely
    if (userId || status === 'accepted') {
        const nType = status === 'accepted' ? 'quote_accepted' : 'quote_updated';
        const { title, message } = notificationTemplates[nType]({
            customerName: `${quote.firstName} ${quote.lastName}`,
            vehicleName: quote.vehicleName || 'N/A',
        });

        if (userId) {
            await safeCreateNotification({
                userId,
                organizationId: orgId,
                type: nType,
                title: status === 'accepted' ? 'Quote Accepted' : 'Quote Status Updated',
                message: status === 'accepted' ? message : `Quote status changed to ${status} for ${quote.firstName} ${quote.lastName}`,
                metadata: {
                    quoteId: quote._id.toString(),
                    customerName: `${quote.firstName} ${quote.lastName}`,
                    status,
                },
            });
        }

        if (status === 'accepted') {
            await notifyOrgAdmins(
                orgId,
                'quote_accepted',
                'Quote Accepted',
                message,
                { quoteId: quote._id.toString(), customerName: `${quote.firstName} ${quote.lastName}` }
            );
        }
    }

    res.json(new ApiResponse(200, quote, 'Quote status updated successfully'));

    // Invalidate quote cache on status change
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);

    await activityService.createActivity({
        userId: userId || 'SYSTEM',
        organizationId: orgId,
        type: 'quote_updated',
        title: 'Status Changed',
        description: `Quote status changed to ${status} for ${quote.firstName} ${quote.lastName}`,
        metadata: { quoteId: quote._id.toString(), status }
    });

    logger.info({ quoteId: quote._id, status }, 'Quote status updated');
});

/**
 * Delete quote
 */
const deleteQuote = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const orgId = req.orgId as string;
    const quote = await Quote.findOne({ _id: req.params.id, organizationId: orgId });

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    const customerName = `${quote.firstName} ${quote.lastName}`;
    const vehicleName = quote.vehicleName;

    await Quote.findOneAndDelete({ _id: req.params.id, organizationId: orgId });

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.quote_deleted({
            customerName,
            vehicleName,
        });

        await safeCreateNotification({
            userId,
            organizationId: orgId,
            type: 'quote_deleted',
            title,
            message,
            metadata: {
                customerName,
                vehicleName,
            },
        });
    }

    notifyOrgAdmins(
        orgId,
        'quote_deleted',
        'Quote Deleted',
        `Quote for ${customerName} (${vehicleName}) has been deleted.`,
        { customerName, vehicleName }
    );

    res.json(new ApiResponse(200, null, 'Quote deleted successfully'));

    // Real-time: notify org members
    const _ioD = getSocketIO();
    if (_ioD) _ioD.to(`org:${orgId}`).emit('quote:change', { action: 'deleted' });

    await activityService.createActivity({
        userId: userId || 'SYSTEM',
        organizationId: orgId,
        type: 'quote_deleted',
        title: 'Draft Deleted',
        description: `Quote for ${customerName} was removed from the system`
    });

    logger.warn({ quoteId: req.params.id, orgId }, 'Quote deleted');
});

/**
 * Convert a quote into a Load for dispatch
 * POST /api/quotes/:id/convert-to-load
 */
const convertToLoad = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const orgId = req.orgId as string;

    if (!userId) {
        throw new ApiError(
            401,
            'Authenticated user is required to convert a quote to a load'
        );
    }

    const quote = await Quote.findOne({
        _id: req.params.id,
        organizationId: orgId,
    });

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    if (quote.status === 'rejected') {
        throw new ApiError(400, 'Cannot convert a rejected quote');
    }

    if (quote.status === 'booked') {
        const existingLoad = await Load.findOne({
            quoteId: quote._id,
            organizationId: orgId,
        });

        if (existingLoad) {
            quote.status = 'booked';
            await quote.save();

            throw new ApiError(
                409,
                `This quote has already been converted to load ${existingLoad.loadNumber}`
            );
        }

        throw new ApiError(409, 'This quote has already been converted to a load');
    }

    const existingLoad = await Load.findOne({
        quoteId: quote._id,
        organizationId: orgId,
    });

    if (existingLoad) {
        quote.status = "booked";
        await quote.save();

        throw new ApiError(
            409,
            `This quote has already been converted to load ${existingLoad.loadNumber}`
        );
    }

    // Parse city/state from address strings such as:
    // "Salt Lake City, UT 84101"
    const parseAddress = (address: string, zip: string) => {
        const normalizedAddress = (address || '').trim();
        const normalizedZip = (zip || '').trim();
        const parts = normalizedAddress
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);

        const city = parts[0] || normalizedAddress || 'Unknown';
        const stateAndZip = parts[1] || '';

        const stateMatch = stateAndZip.match(/\b([A-Za-z]{2})\b/);
        const state = stateMatch?.[1]?.toUpperCase() || 'XX';

        return {
            city,
            state,
            zip: normalizedZip,
            country: 'US',
        };
    };

    const pickupLocation = parseAddress(
        quote.fromAddress,
        quote.fromZip
    );

    const deliveryLocation = parseAddress(
        quote.toAddress,
        quote.toZip
    );

    const trailerType = quote.enclosedTrailer ? 'enclosed' : 'open';

    const vehicleNameParts = (quote.vehicleName || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    const possibleYear = Number.parseInt(vehicleNameParts[0] || '', 10);
    const vehicleYear = Number.isNaN(possibleYear)
        ? undefined
        : possibleYear;

    const load = await Load.create({
        organizationId: orgId,
        orgId: (req as Request & { orgObjectId?: unknown }).orgObjectId,
        createdBy: userId,
        quoteId: quote._id,

        postType: 'load-board',
        status: 'Draft',

        // trailerType is required at the top level of the Load schema.
        trailerType,

        pickupLocation,
        deliveryLocation,

        vehicles: [
            {
                vehicleId: quote.vehicleId,
                hasVin: Boolean(quote.vin),
                vin: quote.vin,
                vehicleType: 'sedan',
                condition: quote.vehicleInoperable
                    ? 'Inoperable'
                    : 'Operable',
                ...(quote.vehicleName
                    ? {
                        year: vehicleYear,
                        make: vehicleNameParts[1] || undefined,
                        model:
                            vehicleNameParts.slice(2).join(' ') ||
                            undefined,
                    }
                    : {}),
            },
        ],

        pricing: {
            miles: quote.miles,
            estimatedRate: quote.rate,
            carrierPayAmount: quote.rate,
        },

        additionalInfo: {
            visibility: 'public',
            notes: `Converted from quote for ${quote.firstName} ${quote.lastName}`,
        },

        contract: {
            agreedToTerms: false,
        },
    });

    // Preserve the quote for history and mark it as converted.
    quote.status = 'booked';
    await quote.save();

    // Clear cached quote lists so the booked status is reflected.
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);

    const io = getSocketIO();
    if (io) {
        io.to(`org:${orgId}`).emit('load:change', {
            action: 'created',
            loadId: load._id.toString(),
        });

        io.to(`org:${orgId}`).emit('quote:change', {
            action: 'updated',
            quoteId: quote._id.toString(),
        });
    }

    logger.info(
        {
            quoteId: quote._id,
            loadId: load._id,
            orgId,
        },
        'Quote converted to load'
    );

    // Do not let activity logging prevent a successful conversion response.
    try {
        await activityService.createActivity({
            userId,
            organizationId: orgId,
            type: 'quote_updated',
            title: 'Quote Converted to Load',
            description: `Quote for ${quote.firstName} ${quote.lastName} converted to load ${load.loadNumber}`,
            metadata: {
                quoteId: quote._id.toString(),
                loadId: load._id.toString(),
            },
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
    } catch (activityError) {
        logger.error(
            {
                err: activityError,
                quoteId: quote._id,
                loadId: load._id,
                orgId,
            },
            'Quote was converted, but activity logging failed'
        );
    }

    return res.status(201).json(
        new ApiResponse(
            201,
            load,
            'Quote converted to load successfully'
        )
    );
});

export default {
    createQuote,
    getQuotes,
    getQuoteById,
    updateQuote,
    updateQuoteStatus,
    deleteQuote,
    convertToLoad,
};