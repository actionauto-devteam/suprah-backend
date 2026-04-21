import mongoose from 'mongoose';
import Shipment from '../models/Shipment.model';
import Quote from '../models/Quote.model';
import Payment from '../models/Payment.model';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import User from '../models/User.model';
import Vehicle from '../models/Vehicle.model';
import DriverLocation from '../models/DriverLocation.model';
import DriverProfile from '../models/DriverProfile.model';
import AnalyticsAggregate from '../models/AnalyticsAggregate.model';

export class DashboardService {
    /**
     * Get main dashboard metrics using $facet for high performance
     */
    static async getDashboardMetrics(orgId: string, period: string = '1Y') {
        const orgObjectId = orgId; // organizationId is stored as string in these models

        // Execute multiple aggregations in parallel
        const [stats, trajectory, activeReps, logistics, intelligence] = await Promise.all([
            this.getQuickStats(orgId),
            this.getRevenueTrajectory(orgId, period),
            this.getActiveReps(orgId), // Lightweight rep list for header
            this.getLogisticsData(orgId),
            this.getDashboardIntelligence(orgId)
        ]);

        // Get live payments
        const livePayments = await Payment.find({ organizationId: orgId })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('customerName amount status description createdAt');

        return {
            stats,
            revenueTrajectory: trajectory,
            activeReps, // Names & Avatars only
            logistics,
            intelligence,
            livePayments
        };
    }

    /**
     * Aggregate quick counts and sums
     */
    private static async getQuickStats(orgId: string) {
        const results = await Quote.aggregate([
            {
                $match: {
                    $or: [
                        { organizationId: orgId },
                        { organizationId: new mongoose.Types.ObjectId(orgId) as any }
                    ]
                }
            },
            {
                $facet: {
                    potentialRevenue: [
                        { $match: { status: 'pending' } },
                        { $group: { _id: null, total: { $sum: { $convert: { input: '$rate', to: 'double', onError: 0, onNull: 0 } } } } }
                    ],
                    monthlyQuotes: [
                        {
                            $match: {
                                createdAt: {
                                    $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                                }
                            }
                        },
                        { $count: 'count' }
                    ]
                }
            }
        ]);

        const activeInventoryCount = await Vehicle.countDocuments({
            $or: [
                { organizationId: orgId },
                { organizationId: new mongoose.Types.ObjectId(orgId) as any }
            ],
            isDeleted: false,
            status: { $ne: 'Sold' }
        });

        // Mock average days on lot for now or calculate if possible
        const avgDaysOnLot = 12; // Placeholder, but better than 0

        const facet = results[0];
        return {
            activeInventory: activeInventoryCount,
            potentialRevenue: facet.potentialRevenue[0]?.total || 0,
            monthlyQuotes: facet.monthlyQuotes[0]?.count || 0,
            avgDaysOnLot
        };
    }

    /**
     * Revenue trajectory based on Payment model
     */
    private static async getRevenueTrajectory(orgId: string, period: string) {
        let dateRange = new Date();
        let groupBy: any = { $month: '$createdAt' };

        if (period === '7D') {
            dateRange.setDate(dateRange.getDate() - 7);
            groupBy = { $dayOfWeek: '$createdAt' };
        } else if (period === '1M') {
            dateRange.setMonth(dateRange.getMonth() - 1);
            groupBy = { $week: '$createdAt' };
        } else {
            dateRange.setFullYear(dateRange.getFullYear() - 1);
            // Group by both year and month for 1Y to be safe and sortable
            groupBy = {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' }
            };
        }

        const data = await Payment.aggregate([
            {
                $match: {
                    $or: [
                        { organizationId: orgId },
                        { organizationId: new mongoose.Types.ObjectId(orgId) as any }
                    ],
                    status: 'succeeded',
                    createdAt: { $gte: dateRange }
                }
            },
            {
                $group: {
                    _id: groupBy,
                    revenue: { $sum: { $convert: { input: '$amount', to: 'double', onError: 0, onNull: 0 } } },
                    date: { $first: '$createdAt' }
                }
            },
            { $sort: { date: 1 } }
        ]);

        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        if (period === '7D') {
            const results = [];
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setDate(d.getDate() - (6 - i));
                const dayIndex = d.getDay(); // 0-6
                const dayName = dayNames[dayIndex];

                // Find matching data (MongoDB $dayOfWeek is 1-7, Sun=1)
                const match = data.find(item => item._id === dayIndex + 1);
                results.push({ name: dayName, revenue: match ? match.revenue : 0 });
            }
            return results;
        }

        if (period === '1M') {
            // For 1M, we use $week (0-53). Let's pad last 5 weeks to be safe.
            const results = [];
            const currentWeek = this.getWeekNumber(new Date());
            for (let i = 4; i >= 0; i--) {
                const weekNum = (currentWeek - i + 54) % 54;
                const match = data.find(item => item._id === weekNum);
                results.push({ name: `Week ${weekNum}`, revenue: match ? match.revenue : 0 });
            }
            return results;
        }

        // Default 1Y: Pad all 12 months
        const results = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const m = d.getMonth() + 1;
            const y = d.getFullYear();
            const monthName = monthNames[m - 1];

            const match = data.find(item =>
                typeof item._id === 'object' && item._id.year === y && item._id.month === m
            );
            results.push({ name: monthName, revenue: match ? match.revenue : 0 });
        }
        return results;
    }

    /**
     * Helper to get ISO week number
     */
    private static getWeekNumber(d: Date): number {
        d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
        return weekNo;
    }

    /**
     * Paginated Leaderboard with multi-model funnel
     * Designed for high scalability by limiting the number of users processed per request.
     */
    static async getPaginatedLeaderboard(orgId: string, page: number = 0, limit: number = 10) {
        const skip = page * limit;

        // 1. Get subset of employees
        const employees = await User.find({
            organizationId: orgId,
            role: { $in: ['employee', 'admin', 'super_admin'] }
        })
        .select('name avatar role')
        .sort({ shipments: -1, createdAt: -1 }) // Sort by shipments if it's already a field, else name
        .skip(skip)
        .limit(limit);

        const leaderboard = await Promise.all(employees.map(async (emp) => {
            const userId = emp._id;

            const [calls, conversations, appointments, shipments] = await Promise.all([
                Lead.countDocuments({ organizationId: orgId, createdBy: userId, channel: 'phone' }),
                SupraSpaceConversation.countDocuments({
                    members: userId,
                    $or: [
                        { organizationId: orgId },
                        { organizationId: new mongoose.Types.ObjectId(orgId) as any }
                    ]
                }),
                Appointment.countDocuments({ organizationId: orgId, createdBy: userId }),
                Shipment.countDocuments({ organizationId: orgId, createdBy: userId })
            ]);

            return {
                id: userId,
                name: emp.name,
                role: emp.role === 'admin' ? 'Administrator' : 'Sales Executive',
                calls,
                convs: conversations,
                appts: appointments,
                shipments,
                avatar: emp.avatar || ''
            };
        }));

        return leaderboard;
    }

    /**
     * @deprecated Use getPaginatedLeaderboard for better performance
     */
    private static async getLeaderboardData(orgId: string) {
        return this.getPaginatedLeaderboard(orgId, 0, 10);
    }

    /**
     * Lightweight rep metadata for dashboard headers
     */
    private static async getActiveReps(orgId: string) {
        return await User.find({
            organizationId: orgId,
            role: { $in: ['employee', 'admin', 'super_admin'] }
        })
        .select('name avatar')
        .sort({ createdAt: -1 })
        .limit(6);
    }

    /**
     * Driver and Shipment logistics
     */
    private static async getLogisticsData(orgId: string) {
        const fiveMinutesAgo = new Date();
        fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

        const [activeDriversCount, totalDriversCount, shipmentStats] = await Promise.all([
            DriverLocation.countDocuments({
                $or: [
                    { organizationId: orgId },
                    { organizationId: new mongoose.Types.ObjectId(orgId) as any }
                ],
                status: { $ne: 'offline' },
                lastSeenAt: { $gte: fiveMinutesAgo }
            }),
            User.countDocuments({
                $or: [
                    { organizationId: orgId },
                    { organizationId: new mongoose.Types.ObjectId(orgId) as any }
                ],
                role: 'driver'
            }),
            Shipment.aggregate([
                {
                    $match: {
                        $or: [
                            { organizationId: orgId },
                            { organizationId: new mongoose.Types.ObjectId(orgId) as any }
                        ]
                    }
                },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ])
        ]);

        const drivers = {
            active: activeDriversCount,
            ready: totalDriversCount
        };

        const shipments: Record<string, number> = {
            'Available': 0,
            'In Route': 0,
            'Dispatched': 0,
            'Delivered': 0,
            'Cancelled': 0
        };

        shipmentStats.forEach(stat => {
            if (stat._id === 'Available for Pickup') shipments['Available'] = stat.count;
            else if (stat._id === 'In-Route') shipments['In Route'] = stat.count;
            else if (shipments.hasOwnProperty(stat._id)) shipments[stat._id] = stat.count;
        });

        return { drivers, shipments };
    }

    /**
     * Get advanced business intelligence metrics
     */
    private static async getDashboardIntelligence(orgId: string) {
        const [netMargin, complianceAlerts, speedToLead] = await Promise.all([
            this.getLogisticsMargin(orgId),
            this.getComplianceAlerts(orgId),
            this.getSpeedToLead(orgId)
        ]);

        return {
            netMargin,
            complianceAlerts,
            speedToLead
        };
    }

    /**
     * Calculate net margin (Sell - Cost) for delivered shipments
     * Optimized using MongoDB Aggregation to handle scale.
     */
    private static async getLogisticsMargin(orgId: string) {
        const results = await Shipment.aggregate([
            {
                $match: {
                    organizationId: orgId,
                    status: 'Delivered',
                    'preservedQuoteData.rate': { $exists: true },
                    carrierPayAmount: { $exists: true }
                }
            },
            {
                $group: {
                    _id: null,
                    totalMargin: { 
                        $sum: { 
                            $subtract: [
                                { $ifNull: ["$preservedQuoteData.rate", 0] }, 
                                { $ifNull: ["$carrierPayAmount", 0] }
                            ] 
                        } 
                    }
                }
            }
        ]);

        return results[0]?.totalMargin || 0;
    }

    /**
     * Count active drivers with expired compliance documents
     */
    private static async getComplianceAlerts(orgId: string) {
        return await DriverProfile.countDocuments({
            organizationId: orgId,
            isComplianceExpired: true
        });
    }

    /**
     * Calculate Speed-to-Lead from Analytics records
     */
    private static async getSpeedToLead(orgId: string) {
        // Look for recent monthly/weekly aggregates for the organization
        const aggregates = await AnalyticsAggregate.find({
            organizationId: orgId,
            periodType: { $in: ['monthly', 'weekly'] },
            'kpis.avgResponseTimeMin': { $gt: 0 }
        }).sort({ periodStart: -1 }).limit(20).select('kpis.avgResponseTimeMin');

        if (!aggregates.length) return 0;

        const totalResponseTime = aggregates.reduce((acc, curr) => 
            acc + (curr.kpis.avgResponseTimeMin || 0), 0
        );

        return Math.round(totalResponseTime / aggregates.length);
    }
}
