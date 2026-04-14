import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Shipment from '../models/Shipment.model';
import Load from '../models/Load.model';
import Quote from '../models/Quote.model';
import Payment from '../models/Payment.model';
import Organization from '../models/Organization.model';
import User, { IUser } from '../models/User.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { safeCreateNotification, notifyAllOrganizations } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import cacheService from '../services/cache.service';
import { getSocketIO } from '../utils/socketEmitter';
import { storageService, BucketType } from '../services/storage.service';
import activityService from '../services/activity.service';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const SHIPMENT_CACHE_TTL = 60 * 5; // 5 minutes

/**
 * Helper to safely get user ID from request
 */
const getUserId = (req: Request): string | undefined => {
    return (req.user as IUser)?._id?.toString();
};

/**
 * Generate a unique tracking number
 */
const generateTrackingNumber = async (): Promise<string> => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const datePrefix = `${year}${month}${day}`;

    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let trackingNumber: string;
    let isUnique = false;

    while (!isUnique) {
        let randomCode = '';
        for (let i = 0; i < 4; i++) {
            randomCode += characters.charAt(Math.floor(Math.random() * characters.length));
        }

        trackingNumber = `TRK-${datePrefix}-${randomCode}`;

        const existing = await Shipment.findOne({ trackingNumber });
        if (!existing) {
            isUnique = true;
        }
    }

    return trackingNumber!;
};

/**
 * Create a new shipment from a quote
 */
const createShipment = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const orgId = req.orgId as string;
    const { quoteId, requestedPickupDate, autoDeleteQuote = true } = req.body;

    if (!quoteId) {
        throw new ApiError(400, 'Quote ID is required');
    }

    const quote = await Quote.findOne({ _id: quoteId, organizationId: orgId })
        .populate('vehicleId', 'year make modelName vin stockNumber image location');

    if (!quote) {
        throw new ApiError(404, 'Quote not found');
    }

    const existingShipment = await Shipment.findOne({ quoteId, organizationId: orgId });
    if (existingShipment) {
        throw new ApiError(400, 'Shipment already exists for this quote');
    }

    if (quote.status === 'booked') {
        throw new ApiError(400, 'This quote has already been converted to a shipment');
    }

    const trackingNumber = await generateTrackingNumber();

    const isValidObjId = /^[0-9a-fA-F]{24}$/.test(orgId);

    const shipment = await Shipment.create({
        quoteId,
        status: 'Available for Pickup',
        origin: quote.fromAddress,
        destination: quote.toAddress,
        requestedPickupDate: requestedPickupDate || new Date(),
        trackingNumber,
        organizationId: orgId,
        ...(userId && { createdBy: userId }),
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

    const populatedShipment = await Shipment.findOne({ _id: shipment._id, organizationId: orgId })
        .populate({
            path: 'quoteId',
            populate: {
                path: 'vehicleId',
                select: 'year make modelName vin stockNumber image location'
            }
        })
        .populate('createdBy', 'name email avatar');

    if (autoDeleteQuote) {
        await Quote.findOneAndDelete({ _id: quoteId, organizationId: orgId });
    } else {
        await Quote.findOneAndUpdate({ _id: quoteId, organizationId: orgId }, { status: 'booked' });
    }

    // Auto-create a pending Payment record linked to this shipment
    if (userId && quote.rate && quote.rate > 0) {
        const customerName = `${quote.firstName} ${quote.lastName}`.trim();
        const vehicleLabel = quote.vehicleName || 'Vehicle';
        try {
            await Payment.create({
                organizationId: orgId,
                customerId: quote.email,
                customerName,
                customerEmail: quote.email,
                customerPhone: quote.phone,
                amount: quote.rate,
                currency: 'usd',
                description: `Vehicle Transport - ${vehicleLabel}`,
                status: 'pending',
                quoteId,
                shipmentId: shipment._id,
                createdBy: userId,
            });
        } catch (paymentErr) {
            // Non-fatal: log but don't fail the shipment creation
            console.error('[Shipment] Failed to auto-create payment:', paymentErr);
        }
    }

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.shipment_created({
            trackingNumber,
            customerName: `${quote.firstName} ${quote.lastName}`,
        });

        await safeCreateNotification({
            userId,
            organizationId: orgId,
            type: 'shipment_created',
            title,
            message,
            metadata: {
                shipmentId: shipment._id.toString(),
                trackingNumber,
                customerName: `${quote.firstName} ${quote.lastName}`,
                vehicleName: quote.vehicleName,
            },
        });
    }

    notifyAllOrganizations(
        'shipment_created',
        'New Shipment Created',
        `A new shipment ${trackingNumber} has been created for ${quote.firstName} ${quote.lastName}.`,
        { shipmentId: shipment._id.toString(), trackingNumber },
        orgId
    );

    res.status(201).json(
        new ApiResponse(
            201,
            populatedShipment,
            autoDeleteQuote
                ? 'Shipment created successfully. Quote has been removed.'
                : 'Shipment created successfully.'
        )
    );

    // Real-time: notify org members
    const _io = getSocketIO();
    if (_io) _io.to(`org:${orgId}`).emit('shipment:change', { action: 'created' });

    // Log activity
    if (userId) {
        await activityService.createActivity({
            userId,
            organizationId: orgId,
            type: 'shipment_created',
            title: 'Shipment Created',
            description: `Converted quote to shipment ${trackingNumber}`,
            metadata: { shipmentId: shipment._id.toString(), trackingNumber }
        });
    }

    // Invalidate shipment and quote caches on creation
    await cacheService.invalidateByPrefix(`shipments:${orgId}`);
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);

    logger.info({ shipmentId: shipment._id, trackingNumber }, 'Converted quote to shipment');
});

/**
 * Get all shipments (cross-org — all orgs visible for transparency)
 */
const getShipments = asyncHandler(async (req: Request, res: Response) => {
    const { status, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const orgId = req.orgId as string;

    const filter: any = {};
    if (status && status !== 'all') {
        filter.status = status;
    }

    const isCacheable = !search;
    const cacheKey = `shipments:${orgId}:list:${status || 'all'}:p${page}:l${limit}`;

    if (isCacheable) {
        const cached = await cacheService.get(cacheKey);
        if (cached) {
            return res.json(new ApiResponse(200, cached, 'Shipments fetched successfully'));
        }
    }

    const attachOrg = async (list: any[]) => {
        const uniqueOrgIds = [...new Set(list.map((s: any) => s.organizationId?.toString()).filter(Boolean))];
        const validOrgIds = uniqueOrgIds.filter(id => /^[0-9a-fA-F]{24}$/.test(String(id)));
        const orgs = await Organization.find({ _id: { $in: validOrgIds } }).select('name logoUrl');
        const orgMap = new Map<string, { name: string; logoUrl?: string }>();
        orgs.forEach(o => orgMap.set(o._id.toString(), { name: o.name, logoUrl: o.logoUrl }));
        return list.map((s: any) => ({ ...(s.toJSON ? s.toJSON() : s), organization: orgMap.get(s.organizationId?.toString()) || { name: 'Unknown Org' } }));
    };

    let filteredShipments: any[] = [];

    if (search) {
        // Fetch all matching docs, filter in memory (quoteId is populated, not queryable in DB easily)
        const all = await Shipment.find(filter)
            .populate({ path: 'quoteId', populate: { path: 'vehicleId', select: 'year make modelName vin stockNumber image location' } })
            .populate('createdBy', 'name email avatar')
            .sort({ createdAt: -1 });

        const searchLower = (search as string).toLowerCase();
        filteredShipments = all.filter(s => {
            const quote = s.quoteId as any;
            const preserved = s.preservedQuoteData as any;
            return (
                quote?.firstName?.toLowerCase().includes(searchLower) ||
                quote?.lastName?.toLowerCase().includes(searchLower) ||
                quote?.vin?.toLowerCase().includes(searchLower) ||
                quote?.stockNumber?.toLowerCase().includes(searchLower) ||
                preserved?.firstName?.toLowerCase().includes(searchLower) ||
                preserved?.lastName?.toLowerCase().includes(searchLower) ||
                preserved?.vin?.toLowerCase().includes(searchLower) ||
                preserved?.stockNumber?.toLowerCase().includes(searchLower) ||
                s.trackingNumber?.toLowerCase().includes(searchLower)
            );
        });
    } else {
        filteredShipments = await Shipment.find(filter)
            .populate({
                path: 'quoteId',
                populate: {
                    path: 'vehicleId',
                    select: 'year make modelName vin stockNumber image location'
                }
            })
            .populate('createdBy', 'name email avatar')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);
    }

    const total = search ? filteredShipments.length : await Shipment.countDocuments(filter);

    // Attach organization name to each shipment
    const uniqueOrgIds = [...new Set(filteredShipments.map(s => s.organizationId?.toString()).filter(Boolean))];
    const validOrgIds = uniqueOrgIds.filter(id => /^[0-9a-fA-F]{24}$/.test(String(id)));
    const orgs = await Organization.find({ _id: { $in: validOrgIds } }).select('name logoUrl');

    const orgMap = new Map<string, { name: string; logoUrl?: string }>();
    orgs.forEach(o => {
        orgMap.set(o._id.toString(), { name: o.name, logoUrl: o.logoUrl });
    });

    const shipmentsWithOrg = await Promise.all(filteredShipments.map(async s => {
        const shipmentObj = s.toJSON ? s.toJSON() : s;

        // Sign proof of delivery URL if exists
        if (shipmentObj.proofOfDelivery?.imageUrl && !shipmentObj.proofOfDelivery.imageUrl.startsWith('http')) {
            const signedUrl = await storageService.getSignedUrl(shipmentObj.proofOfDelivery.imageUrl);
            if (signedUrl) shipmentObj.proofOfDelivery.imageUrl = signedUrl;
        }

        return {
            ...shipmentObj,
            organization: orgMap.get(s.organizationId?.toString()) || { name: 'Unknown Org' }
        };
    }));

    const responseData = {
        shipments: shipmentsWithOrg,
        pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit)
        }
    };

    if (isCacheable) {
        await cacheService.set(cacheKey, responseData, 300); // 5 mins
    }

    res.json(new ApiResponse(200, responseData, 'Shipments fetched successfully'));
});

/**
 * Get shipment by ID
 */
const getShipmentById = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const shipment = await Shipment.findOne({ _id: req.params.id, organizationId: orgId })
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

    const shipmentObj = shipment.toJSON();
    // Sign proof of delivery URL if exists
    if (shipmentObj.proofOfDelivery?.imageUrl && !shipmentObj.proofOfDelivery.imageUrl.startsWith('http')) {
        const signedUrl = await storageService.getSignedUrl(shipmentObj.proofOfDelivery.imageUrl);
        if (signedUrl) shipmentObj.proofOfDelivery.imageUrl = signedUrl;
    }

    res.json(new ApiResponse(200, shipmentObj, 'Shipment fetched successfully'));
});

/**
 * Update shipment
 */
const updateShipment = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const orgId = req.orgId as string;
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

    if (origin !== undefined) updateData.origin = origin;
    if (destination !== undefined) updateData.destination = destination;

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

    if (carrierInfo) updateData.carrierInfo = carrierInfo;

    const { trailerTypeRequired, vehicleCount, isPostedToBoard, preDispatchNotes } = req.body;
    if (trailerTypeRequired !== undefined) updateData.trailerTypeRequired = trailerTypeRequired;
    if (vehicleCount !== undefined) updateData.vehicleCount = vehicleCount;
    if (isPostedToBoard !== undefined) updateData.isPostedToBoard = Boolean(isPostedToBoard);
    if (preDispatchNotes !== undefined) updateData.preDispatchNotes = preDispatchNotes;

    const {
        carrierPayAmount, copCodAmount, specialInstructions, loadSpecificTerms,
        desiredDeliveryDate, internalLoadId, originContact, destinationContact,
    } = req.body;
    if (carrierPayAmount !== undefined) updateData.carrierPayAmount = carrierPayAmount;
    if (copCodAmount !== undefined) updateData.copCodAmount = copCodAmount;
    if (specialInstructions !== undefined) updateData.specialInstructions = specialInstructions;
    if (loadSpecificTerms !== undefined) updateData.loadSpecificTerms = loadSpecificTerms;
    if (desiredDeliveryDate !== undefined) updateData.desiredDeliveryDate = desiredDeliveryDate ? new Date(desiredDeliveryDate) : null;
    if (internalLoadId !== undefined) updateData.internalLoadId = internalLoadId;
    if (originContact !== undefined) updateData.originContact = originContact;
    if (destinationContact !== undefined) updateData.destinationContact = destinationContact;

    const shipment = await Shipment.findOneAndUpdate(
        { _id: req.params.id, organizationId: orgId },
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

    // Create notification safely
    if (userId) {
        const quote = shipment.quoteId as any;
        const preserved = shipment.preservedQuoteData as any;
        const customerName = quote
            ? `${quote.firstName} ${quote.lastName}`
            : preserved
                ? `${preserved.firstName} ${preserved.lastName}`
                : 'Customer';

        const { title, message } = notificationTemplates.shipment_updated({
            trackingNumber: shipment.trackingNumber || 'N/A',
            customerName,
            status: shipment.status,
        });

        await safeCreateNotification({
            userId,
            organizationId: orgId,
            type: 'shipment_updated',
            title,
            message,
            metadata: {
                shipmentId: shipment._id.toString(),
                trackingNumber: shipment.trackingNumber,
                customerName,
                status: shipment.status,
            },
        });

        if (status && shipment.assignedDriverId) {
            const driver = await User.findById(shipment.assignedDriverId);
            if (driver) {
                const nType = status === 'Delivered' ? 'shipment_delivered' : 'shipment_status_changed';
                await safeCreateNotification({
                    userId: driver._id.toString(),
                    organizationId: orgId,
                    type: nType,
                    title: status === 'Delivered' ? 'Shipment Delivered' : 'Shipment Status Updated',
                    message: `Shipment ${shipment.trackingNumber || 'N/A'} is now "${status}".`,
                    metadata: { shipmentId: shipment._id.toString(), trackingNumber: shipment.trackingNumber, status },
                });
            }
        }

        if (status && ['Delivered', 'Cancelled'].includes(status)) {
            notifyAllOrganizations(
                status === 'Delivered' ? 'shipment_delivered' : 'shipment_status_changed',
                status === 'Delivered' ? 'Shipment Delivered' : 'Shipment Cancelled',
                `Shipment ${shipment.trackingNumber || 'N/A'} is now "${status}".`,
                { shipmentId: shipment._id.toString(), trackingNumber: shipment.trackingNumber, status },
                orgId
            );
        }
    }

    res.json(new ApiResponse(200, shipment, 'Shipment updated successfully'));

    // Real-time: notify org members
    const _io = getSocketIO();
    if (_io) _io.to(`org:${orgId}`).emit('shipment:change', { action: 'updated' });

    // Log activity
    if (userId) {
        await activityService.createActivity({
            userId,
            organizationId: orgId,
            type: status === 'Delivered' ? 'load_delivered' : 'shipment_updated',
            title: status === 'Delivered' ? 'Shipment Delivered' : 'Shipment Updated',
            description: `Updated shipment ${shipment.trackingNumber} to status: ${status || 'Updated'}`,
            metadata: { shipmentId: shipment._id.toString(), status, originalStatus: shipment.status }
        });
    }

    // Invalidate shipment cache on update
    await cacheService.invalidateByPrefix(`shipments:${orgId}`);

    logger.info({ shipmentId: shipment._id, status }, 'Shipment details updated');
});

/**
 * Add note to shipment
 */
const addShipmentNote = asyncHandler(async (req: Request, res: Response) => {
    const { text } = req.body;
    const userId = (req.user as IUser)?._id;
    const orgId = req.orgId as string;

    if (!text) {
        throw new ApiError(400, 'Note text is required');
    }

    if (!userId) {
        throw new ApiError(401, 'User not authenticated');
    }

    const shipment = await Shipment.findOneAndUpdate(
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
    const userId = getUserId(req);
    const orgId = req.orgId as string;
    const shipment = await Shipment.findOne({ _id: req.params.id, organizationId: orgId });

    // --- Load fallback: ID belongs to a Load document, not a Shipment ---
    if (!shipment) {
        const load = await Load.findOne({ _id: req.params.id, organizationId: orgId });
        if (!load) throw new ApiError(404, 'Shipment not found');

        await Load.findByIdAndDelete(req.params.id);

        const _io = getSocketIO();
        if (_io) {
            _io.to(`org:${orgId}`).emit('load:change', { action: 'deleted' });
            _io.to(`org:${orgId}`).emit('shipment:change', { action: 'deleted' });
        }

        if (userId) {
            await activityService.createActivity({
                userId,
                organizationId: orgId,
                type: 'shipment_deleted',
                title: 'Load Deleted',
                description: `Deleted load ${load.loadNumber || req.params.id}`,
                metadata: { loadId: req.params.id, loadNumber: load.loadNumber },
            });
        }

        return res.json(new ApiResponse(200, null, 'Load deleted successfully.'));
    }

    const trackingNumber = shipment.trackingNumber || 'N/A';
    const preserved = shipment.preservedQuoteData as any;
    const customerName = preserved ? `${preserved.firstName} ${preserved.lastName}` : 'Customer';

    const existingQuote = await Quote.findOne({ _id: shipment.quoteId, organizationId: orgId });

    if (existingQuote) {
        await Quote.findOneAndUpdate({ _id: shipment.quoteId, organizationId: orgId }, { status: 'accepted' });
    } else if (shipment.preservedQuoteData) {
        await Quote.create({
            _id: shipment.quoteId,
            organizationId: orgId,
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

    await Shipment.findOneAndDelete({ _id: req.params.id, organizationId: orgId });

    // Create notification safely
    if (userId) {
        const { title, message } = notificationTemplates.shipment_deleted({
            trackingNumber,
            customerName,
        });

        await safeCreateNotification({
            userId,
            organizationId: orgId,
            type: 'shipment_deleted',
            title,
            message,
            metadata: {
                trackingNumber,
                customerName,
            },
        });
    }

    notifyAllOrganizations(
        'shipment_deleted',
        'Shipment Deleted',
        `Shipment ${trackingNumber} for ${customerName} has been deleted.`,
        { trackingNumber, customerName },
        orgId
    );

    res.json(
        new ApiResponse(
            200,
            null,
            existingQuote
                ? 'Shipment deleted successfully. Quote status updated to accepted.'
                : 'Shipment deleted successfully. Quote has been restored.'
        )
    );

    // Real-time: notify org members
    const _io = getSocketIO();
    if (_io) _io.to(`org:${orgId}`).emit('shipment:change', { action: 'deleted' });

    // Log activity
    if (userId) {
        await activityService.createActivity({
            userId,
            organizationId: orgId,
            type: 'shipment_deleted',
            title: 'Shipment Deleted',
            description: `Deleted shipment ${trackingNumber}`,
            metadata: { shipmentId: req.params.id, trackingNumber }
        });
    }

    logger.warn({ shipmentId: req.params.id, trackingNumber }, 'Shipment deleted');
});

/**
 * POST /shipments/:id/submit-proof
 * Driver submits a proof-of-delivery image. Notifies org admins.
 */
const submitProofOfDelivery = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) throw new ApiError(401, 'User not authenticated');

    const { id: shipmentId } = req.params;
    const { note } = req.body;
    const file = (req as any).file as Express.Multer.File | undefined;

    if (!file) {
        throw new ApiError(400, 'Proof image is required');
    }

    // Find by ID only — no org filter. Security is enforced via assignedDriverId check below.
    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) throw new ApiError(404, 'Shipment not found');

    // Verify the logged-in user is the assigned driver
    if (!shipment.assignedDriverId || shipment.assignedDriverId.toString() !== userId) {
        throw new ApiError(403, 'Only the assigned driver can submit proof of delivery');
    }

    // Delete old proof if it exists (handles both R2 keys and legacy local paths)
    if (shipment.proofOfDelivery?.imageUrl) {
        await storageService.delete(shipment.proofOfDelivery.imageUrl, BucketType.PRIVATE);
    }

    // Upload new image to R2 PRIVATE bucket
    const imageUrl = await storageService.upload(file, 'proof-of-delivery', BucketType.PRIVATE);

    // Auto-route proof to whoever created the shipment/quote
    const submittedTo = shipment.createdBy
        ? new mongoose.Types.ObjectId(shipment.createdBy.toString())
        : undefined;

    shipment.proofOfDelivery = {
        imageUrl,
        submittedAt: new Date(),
        note: note || undefined,
        submittedTo,
    };

    await shipment.save();

    logger.info({ shipmentId: shipment._id, userId }, 'Proof of delivery submitted');

    // Log activity (Persona: Driver delivering)
    if (userId) {
        await activityService.logLoadActivity(
            userId,
            shipment.organizationId?.toString(),
            'load_delivered',
            shipment._id.toString(),
            `Submitted proof of delivery for shipment ${shipment.trackingNumber}`
        );
    }

    const shipmentOrgId = shipment.organizationId.toString();

    // Notify the admin who created the shipment; fallback to all admins
    const notifyIds: string[] = submittedTo
        ? [submittedTo.toString()]
        : (await User.find({ organizationId: shipment.organizationId, role: { $in: ['admin', 'user', 'super_admin'] } }).select('_id')).map((a: any) => a._id.toString());

    for (const adminId of notifyIds) {
        await safeCreateNotification({
            userId: adminId,
            organizationId: shipmentOrgId,
            type: 'proof_submitted',
            title: 'Proof of Delivery Submitted',
            message: `Driver submitted proof of delivery for shipment ${shipment.trackingNumber || shipmentId}`,
            metadata: {
                shipmentId,
                trackingNumber: shipment.trackingNumber,
                imageUrl,
            },
        });
    }

    res.json(new ApiResponse(200, shipment, 'Proof of delivery submitted successfully'));
});

/**
 * GET /shipments/:id/proof-image
 * Streams the private proof image to authenticated admin/dealer clients.
 */
const streamProofImage = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const shipment = await Shipment.findOne({ _id: req.params.id, organizationId: orgId }).lean();
    if (!shipment) throw new ApiError(404, 'Shipment not found');

    const key = (shipment as any).proofOfDelivery?.imageUrl;
    if (!key) throw new ApiError(404, 'No proof image submitted');

    const result = await storageService.streamPrivateFile(key);
    if (!result) throw new ApiError(404, 'Proof image not found in storage');

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    result.stream.pipe(res);
});

/**
 * POST /shipments/:id/confirm-delivery
 * Org admin confirms the driver's proof of delivery. Sets status to Delivered.
 */
const confirmDelivery = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) throw new ApiError(401, 'User not authenticated');

    const orgId = req.orgId as string;
    const { id: shipmentId } = req.params;

    const shipment = await Shipment.findOne({ _id: shipmentId, organizationId: orgId });
    if (!shipment) throw new ApiError(404, 'Shipment not found');

    if (!shipment.proofOfDelivery?.imageUrl) {
        throw new ApiError(400, 'No proof of delivery has been submitted yet');
    }

    const updated = await Shipment.findOneAndUpdate(
        { _id: shipmentId, organizationId: orgId },
        {
            status: 'Delivered',
            delivered: new Date(),
            'proofOfDelivery.confirmedAt': new Date(),
            'proofOfDelivery.confirmedBy': userId,
        },
        { new: true }
    );

    // Notify the driver
    if (shipment.assignedDriverId) {
        const driverUserId = shipment.assignedDriverId.toString();
        await safeCreateNotification({
            userId: driverUserId,
            organizationId: orgId,
            type: 'delivery_confirmed',
            title: 'Delivery Confirmed',
            message: `Your delivery for shipment ${shipment.trackingNumber || shipmentId} has been confirmed`,
            metadata: {
                shipmentId,
                trackingNumber: shipment.trackingNumber,
            },
        });
    }

    // Log activity (Persona: Admin confirming delivery)
    if (userId) {
        await activityService.createActivity({
            userId,
            organizationId: orgId,
            type: 'load_delivered',
            title: 'Delivery Confirmed',
            description: `Admin confirmed proof of delivery for shipment ${shipment.trackingNumber}`,
            metadata: { shipmentId: shipment._id.toString(), trackingNumber: shipment.trackingNumber }
        });
    }

    logger.info({ shipmentId: shipment._id, userId }, 'Delivery confirmed by admin');

    res.json(new ApiResponse(200, updated, 'Delivery confirmed successfully'));
});

/**
 * Get shipment statistics for the current organization
 */
const getShipmentStats = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const stats = await Shipment.aggregate([
        {
            $match: { organizationId: orgId }
        },
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
    getShipmentStats,
    submitProofOfDelivery,
    streamProofImage,
    confirmDelivery,
};