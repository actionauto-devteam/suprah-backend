import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Shipment from '../models/Shipment.model';
import Quote from '../models/Quote.model';
import Payment from '../models/Payment.model';
import AuditLog from '../models/AuditLog.model';
import User, { IUser } from '../models/User.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';

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

    const shipment = await Shipment.create({
        quoteId,
        status: 'Available for Pickup',
        origin: quote.fromAddress,
        destination: quote.toAddress,
        requestedPickupDate: requestedPickupDate || new Date(),
        trackingNumber,
        organizationId: orgId,
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
        });

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

    res.status(201).json(
        new ApiResponse(
            201,
            populatedShipment,
            autoDeleteQuote
                ? 'Shipment created successfully. Quote has been removed.'
                : 'Shipment created successfully.'
        )
    );

    await AuditLog.create({
        entityType: 'Shipment',
        entityId: shipment._id,
        action: 'CREATE',
        reason: 'Shipment created from quote',
        performedBy: userId,
        changes: { quoteId, trackingNumber }
    });
});

/**
 * Get all shipments
 */
const getShipments = asyncHandler(async (req: Request, res: Response) => {
    const { status, search } = req.query;
    const orgId = req.orgId as string;

    const filter: any = { organizationId: orgId };

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

    res.json(new ApiResponse(200, shipment, 'Shipment fetched successfully'));
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
    }

    res.json(new ApiResponse(200, shipment, 'Shipment updated successfully'));

    await AuditLog.create({
        entityType: 'Shipment',
        entityId: shipment._id,
        action: 'UPDATE',
        reason: 'Shipment updated',
        performedBy: userId,
        changes: updateData
    });
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

    if (!shipment) {
        throw new ApiError(404, 'Shipment not found');
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

    res.json(
        new ApiResponse(
            200,
            null,
            existingQuote
                ? 'Shipment deleted successfully. Quote status updated to accepted.'
                : 'Shipment deleted successfully. Quote has been restored.'
        )
    );

    await AuditLog.create({
        entityType: 'Shipment',
        entityId: req.params.id,
        action: 'DELETE',
        reason: 'Shipment deleted',
        performedBy: userId
    });
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

    const imageUrl = `/uploads/proof-of-delivery/${shipmentId}/${file.filename}`;

    shipment.proofOfDelivery = {
        imageUrl,
        submittedAt: new Date(),
        note: note || undefined,
    };

    await shipment.save();

    // Use the shipment's own organizationId for notifications
    const shipmentOrgId = shipment.organizationId.toString();

    const admins = await User.find({
        organizationId: shipment.organizationId,
        role: { $in: ['admin', 'user', 'super_admin'] },
    }).select('_id');

    for (const admin of admins) {
        await safeCreateNotification({
            userId: admin._id.toString(),
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

    res.json(new ApiResponse(200, updated, 'Delivery confirmed successfully'));
});

/**
 * Get shipment statistics
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
    confirmDelivery,
};