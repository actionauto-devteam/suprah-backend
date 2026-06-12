import { Request, Response } from 'express';
import { google } from 'googleapis';
import CrmUser from '../models/CrmUser.model';
import Appointment from '../models/Appointment.model';
import googleCalendarService from '../services/googleCalendar.service';
import { encrypt } from '../utils/crypto';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import config from '../config';
import appointmentService from '../services/appointment.service';
import { emitToOrg, emitToUser } from '../utils/socketEmitter';


const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];
const CRM_REDIRECT_URI = `${config.backendUrl}/api/crm/calendar/callback`;


export const crmCalendarController = {
  /**
   * 1. Start OAuth Flow
   */
  connect: asyncHandler(async (req: Request, res: Response) => {
    const oauth2Client = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      CRM_REDIRECT_URI
    );

    const crmUserId = (req.crmUser as any)._id.toString();

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state: crmUserId, // Pass the CRM User ID in state
    });

    res.json({ url: authUrl });
  }),

  /**
   * 2. Handle Google Callback
   */
  callback: asyncHandler(async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!code || !state) {
      throw new ApiError(400, 'Missing code or state from Google');
    }

    const oauth2Client = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      CRM_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code as string);
    const crmUserId = state as string;

    // Get user info to get email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    // Update CrmUser with tokens
    await CrmUser.findByIdAndUpdate(crmUserId, {
      $set: {
        googleCalendar: {
          calendarConnected: true,
          gmailAddress: userInfo.data.email,
          accessToken: encrypt(tokens.access_token!),
          refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
          expiryDate: tokens.expiry_date,
          lastSyncAt: new Date(),
        },
      },
    });

    // Start initial sync in background
    googleCalendarService.syncCrmUserCalendar(crmUserId).catch(err => {
      console.error(`Initial sync failed for CrmUser ${crmUserId}:`, err);
    });

    // Redirect to frontend CRM settings
    res.redirect(`${config.frontendUrl}/crm/appointments?calendar=connected`);
  }),

  /**
   * 3. Sync Calendar
   */
  sync: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const forceFullSync = req.query.forceFullSync === 'true' || req.body?.forceFullSync === true;
    
    if (forceFullSync) {
      console.log(`🔄 Force full sync requested for CrmUser ${crmUserId}`);
    }
    
    const count = await googleCalendarService.syncCrmUserCalendar(crmUserId, forceFullSync);
    res.json({ 
      success: true, 
      message: forceFullSync 
        ? `Full sync complete: ${count} events updated across 9-month window.`
        : `Quick sync complete: ${count} events updated for current rolling window.`, 
      count,
      forceFullSync 
    });
  }),

  /**
   * 4. Disconnect
   */
  disconnect: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    await googleCalendarService.disconnectCalendar(crmUserId);
    res.json({ success: true, message: 'Calendar disconnected' });
  }),

  /**
   * 5. Get Status
   */
  getStatus: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const user = await CrmUser.findById(crmUserId).select('googleCalendar');
    
    res.json({
      connected: !!user?.googleCalendar?.calendarConnected,
      email: user?.googleCalendar?.gmailAddress,
      lastSyncAt: user?.googleCalendar?.lastSyncAt,
    });
  }),

  /**
   * 6. Get Appointments
   */
  getAppointments: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const { skip = 0, limit = 2500, startDate, endDate } = req.query;

    const filter: any = {
      participants: crmUserId,
      status: { $ne: 'cancelled' },
    };

    if (startDate || endDate) {
      filter.startTime = {};
      if (startDate) filter.startTime.$gte = new Date(startDate as string);
      if (endDate) filter.startTime.$lte = new Date(endDate as string);
    }

    const appointments = await Appointment
      .find(filter)
      .populate('createdBy participants', 'fullName name email avatar') // SENIOR FIX: Populate for UI
      .sort({ startTime: 1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean();

    const total = await Appointment.countDocuments(filter);

    res.json({
      data: appointments,
      total,
      skip: Number(skip),
      limit: Number(limit),
    });
  }),

  /**
   * 7. Create Appointment
   */
  createAppointment: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const orgId = (req.crmUser as any).organizationId.toString();

    const appointment = await appointmentService.createAppointment(
      crmUserId,
      orgId,
      req.body
    );

    res.status(201).json({
      success: true,
      data: appointment,
      message: 'Appointment created successfully',
    });
  }),

  /**
   * 8. Update Appointment
   */
  updateAppointment: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const orgId = (req.crmUser as any).organizationId.toString();
    const { id } = req.params;

    const appointment = await appointmentService.updateAppointment(
      id,
      orgId,
      crmUserId,
      req.body
    );

    res.json({
      success: true,
      data: appointment,
      message: 'Appointment updated successfully',
    });
  }),

  /**
   * 9. Cancel Appointment
   */
  cancelAppointment: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const orgId = (req.crmUser as any).organizationId.toString();
    const { id } = req.params;

    const appointment = await appointmentService.cancelAppointment(
      id,
      orgId,
      crmUserId
    );

    res.json({
      success: true,
      data: appointment,
      message: 'Appointment cancelled successfully',
    });
  }),

  /**
   * 11. Update Status (Quick Actions)
   */
  updateStatus: asyncHandler(async (req: Request, res: Response) => {
    const orgId = (req.crmUser as any).organizationId.toString();
    const { id } = req.params;
    const { status, outcomeNotes } = req.body;

    if (!['scheduled', 'confirmed', 'cancelled', 'completed', 'no-show'].includes(status)) {
      throw new ApiError(400, 'Invalid status');
    }

    // Direct update — CRM staff can update any booking in their org without creator check
    const updateFields: Record<string, any> = { status };
    if (outcomeNotes) updateFields.outcomeNotes = outcomeNotes;

    const appointment = await Appointment.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      updateFields,
      { new: true }
    );

    if (!appointment) throw new ApiError(404, 'Appointment not found');

    // Push update to org (CRM table refreshes live) and to the customer (stepper advances live)
    emitToOrg(orgId, 'appointment:status_updated', { _id: id, status, orgId });
    const customerId = (appointment as any)?.createdBy?.toString?.();
    if (customerId) {
      emitToUser(customerId, 'appointment:status_updated', { _id: id, status });
    }

    res.json({
      success: true,
      data: appointment,
      message: `Appointment status updated to ${status}`,
    });
  }),

  /**
   * 12. Delete Appointment
   */
  deleteAppointment: asyncHandler(async (req: Request, res: Response) => {
    const crmUserId = (req.crmUser as any)._id.toString();
    const orgId = (req.crmUser as any).organizationId.toString();
    const { id } = req.params;

    await appointmentService.deleteAppointment(
      id,
      orgId,
      crmUserId
    );

    res.json({
      success: true,
      message: 'Appointment deleted successfully',
    });
  }),
};

 
export default crmCalendarController;
