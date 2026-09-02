import mongoose from 'mongoose';
import { Request, Response } from 'express';
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
import { createLoadSchema } from '../validations/load.validation';

const QUOTE_CACHE_TTL = 60 * 5;

const escapeRegex = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSearchQuery = (value: unknown): string => {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, 120);
};

const getUserId = (req: Request): string | undefined => {
    return (req.user as IUser)?._id?.toString();
};

type QuoteLocationInput = Partial<{
    name: string;
    streetAddress: string;
    city: string;
    state: string;
    zip: string;
    country: string;
}>;

const ZIP_RE = /^\d{5}(-\d{4})?$/;

function normalizeStructuredQuoteLocation(
    raw: QuoteLocationInput | undefined,
    label: 'Origin' | 'Destination',
) {
    if (!raw) return undefined;

    const city = String(raw.city || '').trim();
    const state = String(raw.state || '').trim().toUpperCase();
    const zip = String(raw.zip || '').trim();

    if (!city) {
        throw new ApiError(400, `${label} city is required`);
    }
    if (!state) {
        throw new ApiError(400, `${label} state is required`);
    }
    if (!/^[A-Z]{2}$/.test(state)) {
        throw new ApiError(400, `${label} state must use a 2-letter code`);
    }
    if (!ZIP_RE.test(zip)) {
        throw new ApiError(400, `${label} ZIP code must be 5 digits`);
    }

    return {
        name: String(raw.name || '').trim(),
        streetAddress: String(raw.streetAddress || '').trim(),
        city,
        state,
        zip,
        country: String(raw.country || 'US').trim().toUpperCase(),
    };
}

function formatLegacyQuoteAddress(
    location: {
        streetAddress?: string;
        city: string;
        state: string;
    },
) {
    return [
        String(location.streetAddress || '').trim(),
        [location.city, location.state].filter(Boolean).join(', '),
    ]
        .filter(Boolean)
        .join(', ');
}

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
        fromLocation,
        toLocation,
        units = 1,
        enclosedTrailer = false,
        vehicleInoperable = false
    } = req.body;
    const orgId = req.orgId as string;

    if (!firstName || !lastName || !email || !phone) {
        throw new ApiError(400, 'Customer information is required');
    }

    const normalizedFromLocation = normalizeStructuredQuoteLocation(
        fromLocation as QuoteLocationInput | undefined,
        'Origin',
    );
    const normalizedToLocation = normalizeStructuredQuoteLocation(
        toLocation as QuoteLocationInput | undefined,
        'Destination',
    );

    const resolvedFromZip =
        normalizedFromLocation?.zip || String(fromZip || '').trim();
    const resolvedToZip =
        normalizedToLocation?.zip || String(toZip || '').trim();

    const resolvedFromAddress = normalizedFromLocation
        ? formatLegacyQuoteAddress(normalizedFromLocation)
        : String(fromAddress || '').trim();

    const resolvedToAddress = normalizedToLocation
        ? formatLegacyQuoteAddress(normalizedToLocation)
        : String(toAddress || '').trim();

    // Legacy clients are still supported. New clients send structured
    // locations, where Street is optional but City/State/ZIP are required.
    if (
        !resolvedFromZip ||
        !resolvedToZip ||
        !resolvedFromAddress ||
        !resolvedToAddress
    ) {
        throw new ApiError(400, 'Shipping route information is required');
    }

    if (!ZIP_RE.test(resolvedFromZip) || !ZIP_RE.test(resolvedToZip)) {
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

    const fromCoords = await getCoordinatesFromZip(resolvedFromZip);
    if (!fromCoords) {
        throw new ApiError(400, 'Invalid origin ZIP code');
    }

    const toCoords = await getCoordinatesFromZip(resolvedToZip);
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
        fromZip: resolvedFromZip,
        toZip: resolvedToZip,
        fromAddress: resolvedFromAddress,
        toAddress: resolvedToAddress,
        ...(normalizedFromLocation && {
            fromLocation: normalizedFromLocation,
        }),
        ...(normalizedToLocation && {
            toLocation: normalizedToLocation,
        }),
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
    const safeSearch = normalizeSearchQuery(search);
    if (safeSearch) {
        const escapedSearch = escapeRegex(safeSearch);
        filter.$or = [
            { firstName: { $regex: escapedSearch, $options: 'i' } },
            { lastName: { $regex: escapedSearch, $options: 'i' } },
            { email: { $regex: escapedSearch, $options: 'i' } },
            { vin: { $regex: escapedSearch, $options: 'i' } },
            { stockNumber: { $regex: escapedSearch, $options: 'i' } },
        ];
    }

    const isCacheable = !safeSearch;
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
        fromLocation,
        toLocation,
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
    const normalizedFromLocation =
        fromLocation !== undefined
            ? normalizeStructuredQuoteLocation(
                  fromLocation as QuoteLocationInput,
                  'Origin',
              )
            : undefined;

    const normalizedToLocation =
        toLocation !== undefined
            ? normalizeStructuredQuoteLocation(
                  toLocation as QuoteLocationInput,
                  'Destination',
              )
            : undefined;

    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (vehicleName !== undefined) updateData.vehicleName = vehicleName;
    if (vin !== undefined) updateData.vin = vin;
    if (stockNumber !== undefined) updateData.stockNumber = stockNumber;
    if (vehicleLocation !== undefined) updateData.vehicleLocation = vehicleLocation;
    if (normalizedFromLocation) {
        updateData.fromLocation = normalizedFromLocation;
        updateData.fromZip = normalizedFromLocation.zip;
        updateData.fromAddress = formatLegacyQuoteAddress(
            normalizedFromLocation,
        );
    } else {
        if (fromZip !== undefined) updateData.fromZip = fromZip;
        if (fromAddress !== undefined) updateData.fromAddress = fromAddress;

        // A legacy route edit cannot safely keep an older structured object,
        // so null it and let conversion fall back to the updated legacy fields.
        if (fromZip !== undefined || fromAddress !== undefined) {
            updateData.fromLocation = null;
        }
    }

    if (normalizedToLocation) {
        updateData.toLocation = normalizedToLocation;
        updateData.toZip = normalizedToLocation.zip;
        updateData.toAddress = formatLegacyQuoteAddress(
            normalizedToLocation,
        );
    } else {
        if (toZip !== undefined) updateData.toZip = toZip;
        if (toAddress !== undefined) updateData.toAddress = toAddress;

        if (toZip !== undefined || toAddress !== undefined) {
            updateData.toLocation = null;
        }
    }
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

    if (
        fromZip !== undefined ||
        toZip !== undefined ||
        normalizedFromLocation ||
        normalizedToLocation
    ) {
        const quote = await Quote.findOne({ _id: req.params.id, organizationId: orgId });
        if (!quote) {
            throw new ApiError(404, 'Quote not found');
        }

        const finalFromZip =
            updateData.fromZip || fromZip || quote.fromZip;
        const finalToZip =
            updateData.toZip || toZip || quote.toZip;
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
    const quoteId = req.params.id;

    /*
     * Delete in one atomic database operation.
     *
     * Production can briefly display an already-deleted quote when a cached
     * quote list or another browser session is stale. Treating a repeated
     * DELETE as success makes the endpoint idempotent and prevents the UI from
     * remaining stuck on "Deleting..." because of a harmless 404.
     */
    const quote = await Quote.findOneAndDelete({
        _id: quoteId,
        organizationId: orgId,
    });

    /*
     * Always invalidate list caches, including when the record was already
     * deleted. This removes stale quote cards from production immediately.
     */
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);

    if (!quote) {
        logger.info(
            { quoteId, orgId },
            'Quote was already deleted or was no longer visible to this organization',
        );

        return res.json(
            new ApiResponse(
                200,
                null,
                'Quote is already deleted',
            ),
        );
    }

    const customerName = `${quote.firstName} ${quote.lastName}`;
    const vehicleName = quote.vehicleName;

    // Update connected clients immediately.
    const io = getSocketIO();
    if (io) {
        io.to(`org:${orgId}`).emit('quote:change', {
            action: 'deleted',
            quoteId,
        });
    }

    /*
     * Return success as soon as the database deletion and cache invalidation
     * are complete. Notifications and activity logging are non-critical and
     * should not keep the production Delete button loading.
     */
    res.json(
        new ApiResponse(
            200,
            null,
            'Quote deleted successfully',
        ),
    );

    void (async () => {
        const backgroundTasks: Promise<unknown>[] = [];

        if (userId) {
            const { title, message } = notificationTemplates.quote_deleted({
                customerName,
                vehicleName,
            });

            backgroundTasks.push(
                safeCreateNotification({
                    userId,
                    organizationId: orgId,
                    type: 'quote_deleted',
                    title,
                    message,
                    metadata: {
                        customerName,
                        vehicleName,
                    },
                }),
            );
        }

        backgroundTasks.push(
            Promise.resolve(
                notifyOrgAdmins(
                    orgId,
                    'quote_deleted',
                    'Quote Deleted',
                    `Quote for ${customerName} (${vehicleName}) has been deleted.`,
                    { customerName, vehicleName },
                ),
            ),
        );

        backgroundTasks.push(
            activityService.createActivity({
                userId: userId || 'SYSTEM',
                organizationId: orgId,
                type: 'quote_deleted',
                title: 'Draft Deleted',
                description: `Quote for ${customerName} was removed from the system`,
            }),
        );

        const results = await Promise.allSettled(backgroundTasks);
        const failures = results.filter(
            (result) => result.status === 'rejected',
        );

        if (failures.length > 0) {
            logger.error(
                {
                    quoteId,
                    orgId,
                    failures: failures.map((failure) =>
                        failure.status === 'rejected'
                            ? failure.reason
                            : undefined,
                    ),
                },
                'Quote was deleted, but one or more background tasks failed',
            );
        }
    })();

    logger.warn({ quoteId, orgId }, 'Quote deleted');
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

    /*
     * Quotes intentionally keep route entry lightweight and flexible.
     * Load records, however, need a structured location for dispatch,
     * driver routing, editing, and reporting.
     *
     * The frontend may therefore send optional structured route details:
     *   {
     *     pickupLocation: { address, city, state, zip },
     *     deliveryLocation: { address, city, state, zip }
     *   }
     *
     * If those overrides are absent, make a best-effort inference from the
     * quote's free-form address. Missing structure is left empty and the SAME
     * createLoadSchema used by normal Load creation remains the authority.
     */
    const US_STATE_CODES = new Set<string>(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"]);

    type ConversionLocationOverride = Partial<{
        name: string;
        address: string;
        city: string;
        state: string;
        zip: string;
        country: string;
    }>;

    const inferQuoteLocation = (
        address: string,
        zip: string,
    ) => {
        const normalizedAddress = String(address || '').trim();
        const normalizedZip = String(zip || '').trim();

        const inferred = {
            name: '',
            address: normalizedAddress,
            city: '',
            state: '',
            zip: normalizedZip,
            country: 'US',
        };

        if (!normalizedAddress) return inferred;

        const withoutTrailingZip = normalizedAddress
            .replace(/\s+\d{5}(?:-\d{4})?\s*$/, '')
            .trim();

        const stateMatch = withoutTrailingZip.match(
            /(,\s*|\s)([A-Za-z]{2})\s*$/
        );

        // Loose quote text such as "123 MABIN ST" is valid. Do not confuse a
        // street suffix with a state code or invent a city/state.
        if (!stateMatch || stateMatch.index == null) return inferred;

        const stateCandidate = stateMatch[2].toUpperCase();
        if (!US_STATE_CODES.has(stateCandidate)) return inferred;

        const beforeState = withoutTrailingZip
            .slice(0, stateMatch.index)
            .replace(/,\s*$/, '')
            .trim();

        // "Orem UT" can be inferred, but "123 Main CT" should not be treated
        // as City=123 Main / State=CT just because CT is a valid state code.
        const delimiter = stateMatch[1];
        if (!delimiter.includes(',') && /\d/.test(beforeState)) {
            return inferred;
        }

        inferred.state = stateCandidate;

        if (!beforeState) return inferred;

        const commaParts = beforeState
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);

        let city = commaParts[commaParts.length - 1] || '';

        if (commaParts.length === 1 && city.includes(' - ')) {
            const dashParts = city
                .split(/\s+-\s+/)
                .map((part) => part.trim())
                .filter(Boolean);

            if (dashParts.length >= 2) {
                city = dashParts[dashParts.length - 1];
                inferred.name = dashParts.slice(0, -1).join(' - ');
            }
        }

        inferred.city = city;
        return inferred;
    };

    const mergeConversionLocation = (
        quoteAddress: string,
        quoteZip: string,
        storedLocation:
            | {
                  name?: string;
                  streetAddress?: string;
                  city?: string;
                  state?: string;
                  zip?: string;
                  country?: string;
              }
            | null
            | undefined,
        override?: ConversionLocationOverride,
    ) => {
        const inferred = inferQuoteLocation(quoteAddress, quoteZip);

        return {
            name: String(
                override?.name ??
                    storedLocation?.name ??
                    inferred.name ??
                    ''
            ).trim(),
            address: String(
                override?.address ??
                    storedLocation?.streetAddress ??
                    inferred.address ??
                    ''
            ).trim(),
            city: String(
                override?.city ??
                    storedLocation?.city ??
                    inferred.city ??
                    ''
            ).trim(),
            state: String(
                override?.state ??
                    storedLocation?.state ??
                    inferred.state ??
                    ''
            ).trim().toUpperCase(),
            zip: String(
                override?.zip ??
                    storedLocation?.zip ??
                    inferred.zip ??
                    ''
            ).trim(),
            country: String(
                override?.country ??
                    storedLocation?.country ??
                    inferred.country ??
                    'US'
            ).trim().toUpperCase(),
        };
    };

    const requestedPickup =
        (req.body?.pickupLocation ?? undefined) as
            | ConversionLocationOverride
            | undefined;

    const requestedDelivery =
        (req.body?.deliveryLocation ?? undefined) as
            | ConversionLocationOverride
            | undefined;

    const pickupLocation = mergeConversionLocation(
        quote.fromAddress,
        quote.fromZip,
        quote.fromLocation as any,
        requestedPickup,
    );

    const deliveryLocation = mergeConversionLocation(
        quote.toAddress,
        quote.toZip,
        quote.toLocation as any,
        requestedDelivery,
    );

    // Quote only stores open/enclosed. Map that choice to an existing,
    // canonical Load trailer type so converted loads behave like manually
    // created loads in validation, editing, cards, and driver compatibility.
    const trailerType = quote.enclosedTrailer
        ? 'enclosed_2car'
        : 'open_2car';

    const vehicleNameParts = (quote.vehicleName || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    const possibleYear = Number.parseInt(vehicleNameParts[0] || '', 10);
    const vehicleYear = Number.isNaN(possibleYear)
        ? undefined
        : possibleYear;

    const convertedVehicle = {
        ...(quote.vehicleId && {
            vehicleId: quote.vehicleId.toString(),
        }),
        ...(quote.vin && { vin: quote.vin }),
        condition: quote.vehicleInoperable
            ? 'Inoperable' as const
            : 'Operable' as const,
        ...(quote.vehicleName
            ? {
                year: vehicleYear,
                make: vehicleNameParts[1] || undefined,
                model:
                    vehicleNameParts.slice(2).join(' ') ||
                    undefined,
            }
            : {}),
    };

    /*
     * Validate the generated Load-shaped data with the SAME schema used by
     * normal Create Load. This prevents the conversion endpoint from drifting
     * into a second, less strict Load format.
     *
     * Miles/estimatedRate are intentionally added after this validation because
     * normal createLoadSchema accepts dispatcher-entered pricing only; the
     * normal load controller computes those two server-side.
     */
    const conversionPayload = {
        postType: 'load-board' as const,
        pickupLocation,
        deliveryLocation,
        vehicles: [convertedVehicle],
        trailerType,
        additionalInfo: {
            visibility: 'public' as const,
            notes: `Converted from quote for ${quote.firstName} ${quote.lastName}`,
        },
        contract: {
            agreedToTerms: false,
        },
        pricing: {
            carrierPayAmount: quote.rate,
            copCodAmount: 0,
        },
    };

    const parsedConversion = createLoadSchema.safeParse(conversionPayload);

    if (!parsedConversion.success) {
        const messages = parsedConversion.error.issues
            .map((issue) => issue.message)
            .join(', ');

        throw new ApiError(
            400,
            `Additional route details are required before this quote can become a load: ${messages}`
        );
    }

    const load = await Load.create({
        organizationId: orgId,
        orgId: (req as Request & { orgObjectId?: unknown }).orgObjectId,
        createdBy: userId,
        quoteId: quote._id,

        ...parsedConversion.data,

        // A converted quote remains a Draft until dispatch intentionally posts
        // or assigns it; preserve the existing conversion workflow.
        status: 'Draft',

        pricing: {
            miles: quote.miles,
            estimatedRate: quote.rate,
            carrierPayAmount: quote.rate,
            copCodAmount: 0,
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

    {
        const { title, message } = notificationTemplates.quote_converted({
            customerName: `${quote.firstName} ${quote.lastName}`,
            trackingNumber: load.loadNumber,
        });
        notifyOrgAdmins(orgId, 'quote_converted', title, message, {
            quoteId: quote._id.toString(),
            loadId: load._id.toString(),
            route: '/transportation?tab=shipments',
        }).catch((err) => logger.error(err, 'Failed to notify admins of quote conversion'));
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