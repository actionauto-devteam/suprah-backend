import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import Quote from '../models/Quote.model';
import Shipment from '../models/Shipment.model';
import { ApiResponse } from '../utils/ApiResponse';

const getDashboardMetrics = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    // Execute all aggregations in parallel for performance
    const [
        totalActiveVehicles,
        recentActivity,
        quoteStats,
        shipmentStats,
        vehicleStats,
        inventoryHealth
    ] = await Promise.all([
        // 1. Basic Inventory Count
        Vehicle.countDocuments({ isDeleted: false, status: { $ne: 'Sold' } }),

        // 2. Recent Activity (Last 5 updated vehicles)
        Vehicle.find({ isDeleted: false })
            .sort({ updatedAt: -1 })
            .limit(5)
            .select('year make modelName updatedAt status price'),

        // 3. Quote Funnel (Sales Pipeline)
        Quote.aggregate([
            { $match: { organizationId: orgId } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    potentialValue: { $sum: '$rate' }
                }
            }
        ]),

        // 4. Shipment Logistics (Operational Pulse)
        Shipment.aggregate([
            { $match: { organizationId: orgId } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]),

        // 5. Vehicle Status Breakdown (Inventory Overview)
        Vehicle.aggregate([
            { $match: { isDeleted: false } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]),

        // 6. Detailed Inventory Health (Recon & Aging)
        Vehicle.aggregate([
            { $match: { isDeleted: false, status: 'In Recon' } },
            {
                $group: {
                    _id: '$currentStep',
                    count: { $sum: 1 },
                    avgDays: { $avg: '$daysOnLot' } // Track how long they've been stuck
                }
            }
        ])
    ]);

    // --- Process Quote Data ---
    const quoteData = {
        total: 0,
        pending: 0,
        accepted: 0,
        rejected: 0,
        booked: 0,
        potentialRevenue: 0,
        conversionRate: 0
    };

    quoteStats.forEach((stat: any) => {
        quoteData.total += stat.count;
        if (stat._id === 'pending') {
            quoteData.pending = stat.count;
            quoteData.potentialRevenue = stat.potentialValue || 0;
        } else if (stat._id === 'accepted') quoteData.accepted = stat.count;
        else if (stat._id === 'rejected') quoteData.rejected = stat.count;
        else if (stat._id === 'booked') quoteData.booked = stat.count;
    });

    if (quoteData.total > 0) {
        quoteData.conversionRate = parseFloat(((quoteData.booked / quoteData.total) * 100).toFixed(1));
    }

    // --- Process Shipment Data ---
    const shipmentData = {
        total: 0,
        active: 0, // Dispatched + In-Route
        pending: 0, // Available for Pickup
        delivered: 0,
        byStatus: {} as Record<string, number>
    };

    shipmentStats.forEach((stat: any) => {
        shipmentData.total += stat.count;
        shipmentData.byStatus[stat._id] = stat.count;

        if (['Dispatched', 'In-Route'].includes(stat._id)) {
            shipmentData.active += stat.count;
        } else if (stat._id === 'Available for Pickup') {
            shipmentData.pending = stat.count;
        } else if (stat._id === 'Delivered') {
            shipmentData.delivered = stat.count;
        }
    });

    // --- Process Inventory Data ---
    const inventoryData = {
        totalActive: totalActiveVehicles,
        byStatus: {} as Record<string, number>,
        reconPipeline: {} as Record<string, number>,
        aging: {
            averageDaysOnLot: 0 // To be calculated if needed, or derived from detailed stats
        }
    };

    vehicleStats.forEach((stat: any) => {
        inventoryData.byStatus[stat._id] = stat.count;
    });

    inventoryHealth.forEach((stat: any) => {
        if (stat._id) {
            inventoryData.reconPipeline[stat._id] = stat.count;
        }
    });

    // Calculate Average Days on Lot for ALL active inventory (simple query)
    const agingResult = await Vehicle.aggregate([
        { $match: { isDeleted: false, status: { $ne: 'Sold' } } },
        {
            $group: {
                _id: null,
                avgDays: { $avg: '$daysOnLot' }
            }
        }
    ]);
    inventoryData.aging.averageDaysOnLot = agingResult.length > 0 ? Math.round(agingResult[0].avgDays) : 0;


    res.json(new ApiResponse(200, {
        quotes: quoteData,
        shipments: shipmentData,
        inventory: inventoryData,
        recentActivity
    }, 'Dashboard metrics fetched successfully'));
});

export default {
    getDashboardMetrics
};
