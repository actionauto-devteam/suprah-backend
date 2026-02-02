import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import appointmentService from '../services/appointment.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';

/**
 * Create a new appointment
 * @route POST /api/appointments
 * @access Private
 */
const createAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const appointment = await appointmentService.createAppointment(userId, req.body);
    
    res.status(201).json(
        new ApiResponse(201, appointment, 'Appointment created successfully')
    );
});

/**
 * Get all appointments for the logged-in user
 * @route GET /api/appointments
 * @access Private
 */
const getAppointments = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { status, entryType, startDate, endDate, limit, skip } = req.query;
    
    const options: any = {};
    if (status) options.status = status;
    if (entryType) options.entryType = entryType;
    if (startDate) options.startDate = new Date(startDate as string);
    if (endDate) options.endDate = new Date(endDate as string);
    if (limit) options.limit = parseInt(limit as string);
    if (skip) options.skip = parseInt(skip as string);
    
    const result = await appointmentService.getUserAppointments(userId, options);
    
    res.json(
        new ApiResponse(200, result, 'Appointments fetched successfully')
    );
});

/**
 * Get a specific appointment by ID
 * @route GET /api/appointments/:id
 * @access Private
 */
const getAppointmentById = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    const appointment = await appointmentService.getAppointmentById(id, userId);
    
    res.json(
        new ApiResponse(200, appointment, 'Appointment fetched successfully')
    );
});

/**
 * Update an appointment
 * @route PATCH /api/appointments/:id
 * @access Private
 */
const updateAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    const appointment = await appointmentService.updateAppointment(id, userId, req.body);
    
    res.json(
        new ApiResponse(200, appointment, 'Appointment updated successfully')
    );
});

/**
 * Cancel an appointment
 * @route POST /api/appointments/:id/cancel
 * @access Private
 */
const cancelAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    const appointment = await appointmentService.cancelAppointment(id, userId);
    
    res.json(
        new ApiResponse(200, appointment, 'Appointment cancelled successfully')
    );
});

/**
 * Delete an appointment
 * @route DELETE /api/appointments/:id
 * @access Private
 */
const deleteAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    await appointmentService.deleteAppointment(id, userId);
    
    res.json(
        new ApiResponse(200, null, 'Appointment deleted successfully')
    );
});

/**
 * Handle guest response to appointment invitation (Accept/Decline)
 * @route POST /api/appointments/:id/guest-response
 * @access Public (uses token authentication)
 */
const handleGuestResponse = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { token, status, googleAccessToken } = req.body;
    
    if (!token || !status) {
        return res.status(400).json(
            new ApiResponse(400, null, 'Token and status are required')
        );
    }

    if (!['accepted', 'declined'].includes(status)) {
        return res.status(400).json(
            new ApiResponse(400, null, 'Status must be either "accepted" or "declined"')
        );
    }
    
    const appointment = await appointmentService.handleGuestResponse(
        id,
        token,
        status,
        googleAccessToken
    );
    
    res.json(
        new ApiResponse(200, appointment, `Invitation ${status} successfully`)
    );
});

/**
 * Remove duplicate appointments (Admin/Cleanup utility)
 * @route POST /api/appointments/cleanup/duplicates
 * @access Private (Admin only - add admin middleware if needed)
 */
const removeDuplicates = asyncHandler(async (req: Request, res: Response) => {
    const removedCount = await appointmentService.removeDuplicateAppointments();
    
    res.json(
        new ApiResponse(200, { removedCount }, `Removed ${removedCount} duplicate appointments`)
    );
});

/**
 * Send appointment reminders (Cron job endpoint)
 * @route POST /api/appointments/reminders/send
 * @access Private (Admin/System only - add appropriate middleware)
 */
const sendReminders = asyncHandler(async (req: Request, res: Response) => {
    const sentCount = await appointmentService.sendAppointmentReminders();
    
    res.json(
        new ApiResponse(200, { sentCount }, `Sent ${sentCount} appointment reminders`)
    );
});

/**
 * Mark past appointments as completed (Cron job endpoint)
 * @route POST /api/appointments/cleanup/mark-completed
 * @access Private (Admin/System only - add appropriate middleware)
 */
const markPastCompleted = asyncHandler(async (req: Request, res: Response) => {
    const updatedCount = await appointmentService.markPastAppointmentsCompleted();
    
    res.json(
        new ApiResponse(200, { updatedCount }, `Marked ${updatedCount} past appointments as completed`)
    );
});

/**
 * Get appointment statistics for the user
 * @route GET /api/appointments/stats
 * @access Private
 */
const getAppointmentStats = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    
    // Get all user appointments
    const { appointments } = await appointmentService.getUserAppointments(userId, {});
    
    const now = new Date();
    
    const stats = {
        total: appointments.length,
        upcoming: appointments.filter(a => 
            new Date(a.startTime) > now && 
            a.status !== 'cancelled'
        ).length,
        past: appointments.filter(a => 
            new Date(a.endTime) < now
        ).length,
        cancelled: appointments.filter(a => 
            a.status === 'cancelled'
        ).length,
        completed: appointments.filter(a => 
            a.status === 'completed'
        ).length,
        byType: {
            appointment: appointments.filter(a => a.entryType === 'appointment').length,
            event: appointments.filter(a => a.entryType === 'event').length,
            task: appointments.filter(a => a.entryType === 'task').length,
            reminder: appointments.filter(a => a.entryType === 'reminder').length,
        },
        byStatus: {
            scheduled: appointments.filter(a => a.status === 'scheduled').length,
            confirmed: appointments.filter(a => a.status === 'confirmed').length,
            cancelled: appointments.filter(a => a.status === 'cancelled').length,
            completed: appointments.filter(a => a.status === 'completed').length,
        }
    };
    
    res.json(
        new ApiResponse(200, stats, 'Appointment statistics fetched successfully')
    );
});

/**
 * Get upcoming appointments for dashboard/widget
 * @route GET /api/appointments/upcoming
 * @access Private
 */
const getUpcomingAppointments = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const limit = parseInt(req.query.limit as string) || 5;
    
    const { appointments } = await appointmentService.getUserAppointments(userId, {
        limit,
        skip: 0
    });
    
    // Filter to only upcoming, non-cancelled
    const upcoming = appointments
        .filter(a => new Date(a.startTime) > new Date() && a.status !== 'cancelled')
        .slice(0, limit);
    
    res.json(
        new ApiResponse(200, upcoming, 'Upcoming appointments fetched successfully')
    );
});

/**
 * Get appointments for a specific date range (for calendar view)
 * @route GET /api/appointments/date-range
 * @access Private
 */
const getAppointmentsByDateRange = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
        return res.status(400).json(
            new ApiResponse(400, null, 'Start date and end date are required')
        );
    }
    
    const result = await appointmentService.getUserAppointments(userId, {
        startDate: new Date(startDate as string),
        endDate: new Date(endDate as string)
    });
    
    res.json(
        new ApiResponse(200, result, 'Appointments in date range fetched successfully')
    );
});

/**
 * Search appointments
 * @route GET /api/appointments/search
 * @access Private
 */
const searchAppointments = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { q, entryType, status } = req.query;
    
    if (!q || typeof q !== 'string') {
        return res.status(400).json(
            new ApiResponse(400, null, 'Search query is required')
        );
    }
    
    // Get all appointments
    const options: any = {};
    if (entryType) options.entryType = entryType;
    if (status) options.status = status;
    
    const { appointments } = await appointmentService.getUserAppointments(userId, options);
    
    // Filter by search query
    const searchQuery = q.toLowerCase();
    const filtered = appointments.filter(a => 
        a.title.toLowerCase().includes(searchQuery) ||
        a.description?.toLowerCase().includes(searchQuery) ||
        a.location?.toLowerCase().includes(searchQuery) ||
        a.notes?.toLowerCase().includes(searchQuery)
    );
    
    res.json(
        new ApiResponse(200, { appointments: filtered, total: filtered.length }, 'Search completed successfully')
    );
});

export default {
    createAppointment,
    getAppointments,
    getAppointmentById,
    updateAppointment,
    cancelAppointment,
    deleteAppointment,
    handleGuestResponse,
    removeDuplicates,
    sendReminders,
    markPastCompleted,
    getAppointmentStats,
    getUpcomingAppointments,
    getAppointmentsByDateRange,
    searchAppointments
};