import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import appointmentService from '../services/appointment.service';
import customerBookingService from '../services/customerbooking.service';
import enhancedGoogleCalendarService from '../services/googleCalendar.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { safeCreateNotification, notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';

/**
 * Create a new appointment (with customer booking support)
 */
const createAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const orgId = req.orgId as string;

    // Check for duplicate customer booking
    if (req.body.customerBooking?.isCustomerBooking) {
        // Inject organizationId for duplicate check
        const bookingData = { ...req.body.customerBooking, organizationId: orgId };
        const duplicateCheck = await customerBookingService.checkDuplicateBooking(
            bookingData,
            new Date(req.body.startTime)
        );

        if (duplicateCheck.isDuplicate) {
            return res.status(400).json(
                new ApiResponse(400, null, duplicateCheck.reason!)
            );
        }
    }

    const appointment = await appointmentService.createAppointment(userId, orgId, req.body);

    if (orgId) {
        const { title, message } = notificationTemplates.appointment_created({
            title: appointment.title || 'Untitled',
            startTime: appointment.startTime ? new Date(appointment.startTime).toLocaleString() : undefined,
        });
        await notifyOrgAdmins(orgId, 'appointment_created', title, message, {
            appointmentId: appointment._id?.toString(),
        }, userId);
    }

    await activityService.createActivity({
        userId,
        organizationId: orgId || 'global',
        type: 'appointment_created',
        title: 'Appointment Scheduled',
        description: `New appointment "${appointment.title}" scheduled`,
        metadata: { appointmentId: appointment._id?.toString(), startTime: appointment.startTime }
    });

    logger.info({ appointmentId: appointment._id, userId, orgId }, 'Appointment created successfully');

    res.status(201).json(
        new ApiResponse(201, appointment, 'Appointment created successfully')
    );
});

/**
 * Get all appointments for the logged-in user
 */
const getAppointments = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { status, entryType, startDate, endDate, limit, skip, includeCustomerBookings } = req.query;

    const options: any = {};
    if (status) options.status = status;
    if (entryType) options.entryType = entryType;
    if (startDate) options.startDate = new Date(startDate as string);
    if (endDate) options.endDate = new Date(endDate as string);
    if (limit) options.limit = parseInt(limit as string);
    if (skip) options.skip = parseInt(skip as string);
    if (includeCustomerBookings) options.includeCustomerBookings = includeCustomerBookings === 'true';

    const orgId = req.orgId as string;
    const result = await appointmentService.getUserAppointments(userId, orgId, options);

    res.json(
        new ApiResponse(200, result, 'Appointments fetched successfully')
    );
});

/**
 * Get customer bookings only
 */
const getCustomerBookings = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const orgId = req.orgId as string;
    const { startDate, endDate, status } = req.query;

    const options: any = {
        customerBookingsOnly: true
    };

    if (startDate) options.startDate = new Date(startDate as string);
    if (endDate) options.endDate = new Date(endDate as string);
    if (status) options.status = status;

    const result = await appointmentService.getCustomerBookings(userId, orgId, options);

    res.json(
        new ApiResponse(200, result, 'Customer bookings fetched successfully')
    );
});

/**
 * Get customer booking history
 */
const getCustomerHistory = asyncHandler(async (req: Request, res: Response) => {
    const { email, phone, firstName, lastName } = req.query;

    const orgId = req.orgId as string;
    const result = await customerBookingService.getCustomerHistory(
        orgId,
        email as string,
        phone as string,
        firstName as string,
        lastName as string
    );

    res.json(
        new ApiResponse(200, result, 'Customer history fetched successfully')
    );
});

/**
 * Get booking statistics for a specific date
 */
const getDateStatistics = asyncHandler(async (req: Request, res: Response) => {
    const { date } = req.query;
    const orgId = req.orgId as string;

    if (!date) {
        return res.status(400).json(
            new ApiResponse(400, null, 'Date parameter is required')
        );
    }

    const statistics = await customerBookingService.getDateStatistics(
        new Date(date as string),
        orgId
    );

    res.json(
        new ApiResponse(200, statistics, 'Date statistics fetched successfully')
    );
});

/**
 * Sync with Google Calendar
 */
const syncWithGoogleCalendar = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const orgId = req.orgId as string;

    const result = await enhancedGoogleCalendarService.syncAllEvents(orgId, userId);

    res.json(
        new ApiResponse(200, result, 'Synced with Google Calendar successfully')
    );

    logger.info({ userId, orgId }, 'Google Calendar sync completed');
});

/**
 * Get a specific appointment by ID
 */
const getAppointmentById = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;

    const orgId = req.orgId as string;
    const appointment = await appointmentService.getAppointmentById(id, orgId, userId);

    res.json(
        new ApiResponse(200, appointment, 'Appointment fetched successfully')
    );
});

/**
 * Update an appointment
 */
const updateAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;

    // Check for duplicate customer booking if updating customer booking info
    if (req.body.customerBooking?.isCustomerBooking) {
        const orgId = req.orgId as string;
        // Inject organizationId for duplicate check
        const bookingData = { ...req.body.customerBooking, organizationId: orgId };
        const duplicateCheck = await customerBookingService.checkDuplicateBooking(
            bookingData,
            new Date(req.body.startTime),
            id
        );

        if (duplicateCheck.isDuplicate) {
            return res.status(400).json(
                new ApiResponse(400, null, duplicateCheck.reason!)
            );
        }
    }

    const orgId = req.orgId as string;
    const appointment = await appointmentService.updateAppointment(id, orgId, userId, req.body);

    if (orgId) {
        const { title, message } = notificationTemplates.appointment_updated({
            title: appointment.title || 'Untitled',
        });
        await notifyOrgAdmins(orgId, 'appointment_updated', title, message, {
            appointmentId: appointment._id?.toString(),
        }, userId);
    }

    await activityService.createActivity({
        userId,
        organizationId: orgId || 'global',
        type: 'appointment_updated',
        title: 'Appointment Updated',
        description: `Appointment "${appointment.title}" was modified`,
        metadata: { appointmentId: appointment._id?.toString() }
    });

    logger.info({ appointmentId: appointment._id, userId }, 'Appointment updated');

    res.json(
        new ApiResponse(200, appointment, 'Appointment updated successfully')
    );
});

/**
 * Cancel an appointment
 */
const cancelAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;

    const orgId = req.orgId as string;
    const appointment = await appointmentService.cancelAppointment(id, orgId, userId);

    if (orgId) {
        const { title, message } = notificationTemplates.appointment_cancelled({
            title: appointment.title || 'Untitled',
        });
        await notifyOrgAdmins(orgId, 'appointment_cancelled', title, message, {
            appointmentId: appointment._id?.toString(),
        }, userId);
    }

    await activityService.createActivity({
        userId,
        organizationId: orgId || 'global',
        type: 'appointment_cancelled',
        title: 'Appointment Cancelled',
        description: `Appointment "${appointment.title}" was cancelled`,
        metadata: { appointmentId: appointment._id?.toString() }
    });

    logger.warn({ appointmentId: appointment._id, userId }, 'Appointment cancelled');

    res.json(
        new ApiResponse(200, appointment, 'Appointment cancelled successfully')
    );
});

/**
 * Delete an appointment
 */
const deleteAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;

    const orgId = req.orgId as string;
    await appointmentService.deleteAppointment(id, orgId, userId);

    if (orgId) {
        const { title, message } = notificationTemplates.appointment_cancelled({
            title: 'Appointment',
        });
        await notifyOrgAdmins(orgId, 'appointment_cancelled', title, message, {
            appointmentId: id,
        }, userId);
    }

    await activityService.createActivity({
        userId,
        organizationId: orgId || 'global',
        type: 'appointment_cancelled',
        title: 'Appointment Permanently Deleted',
        description: `Appointment record ${id} was removed from the system`,
        metadata: { appointmentId: id }
    });

    logger.warn({ appointmentId: id, userId }, 'Appointment deleted');

    res.json(
        new ApiResponse(200, null, 'Appointment deleted successfully')
    );
});

/**
 * Handle guest response to appointment invitation
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

    if (appointment.createdBy) {
        const { title, message } = notificationTemplates.guest_response({
            guestName: req.body.guestName || 'A guest',
            appointmentTitle: appointment.title || 'your appointment',
            response: status,
        });
        await safeCreateNotification({
            userId: appointment.createdBy.toString(),
            organizationId: appointment.organizationId || '',
            type: 'guest_response',
            title,
            message,
            metadata: { appointmentId: id, guestResponse: status },
        });
    }

    logger.info({ appointmentId: id, status, guestName: req.body.guestName }, 'Guest responded to appointment');

    res.json(
        new ApiResponse(200, appointment, `Invitation ${status} successfully`)
    );
});

/**
 * Get appointment statistics
 */
const getAppointmentStats = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const orgId = req.orgId as string;

    const { appointments } = await appointmentService.getUserAppointments(userId, orgId, {});

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
        customerBookings: appointments.filter(a =>
            a.customerBooking?.isCustomerBooking
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

export default {
    createAppointment,
    getAppointments,
    getCustomerBookings,
    getCustomerHistory,
    getDateStatistics,
    syncWithGoogleCalendar,
    getAppointmentById,
    updateAppointment,
    cancelAppointment,
    deleteAppointment,
    handleGuestResponse,
    getAppointmentStats
};