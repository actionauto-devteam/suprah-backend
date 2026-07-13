import Appointment from '../models/Appointment.model';
import User from '../models/User.model';
import Lead from '../models/lead.model';
import { getSocketIO } from '../utils/socketEmitter';
import notificationService from './notification.service';
import emailService from './email.service';
import googleCalendarService from './googleCalendar.service';
import customerBookingService from './customerbooking.service';
import { ApiError } from '../utils/ApiError';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';

interface CreateAppointmentData {
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  type: 'in-person' | 'phone' | 'video' | 'other';
  entryType: 'event' | 'task' | 'reminder' | 'appointment';
  participants: string[];
  guestEmails?: string[];
  customerBooking?: {
    isCustomerBooking: boolean;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  vehicleId?: string;
  quoteId?: string;
  shipmentId?: string;
  leadId?: string;
  meetingLink?: string;
  notes?: string;
  outcomeNotes?: string;
}

const resolveCalendarTarget = async (userId: string, orgId: string) => {
  const isCrmUser = await CrmUser.exists({ _id: userId });
  if (isCrmUser) return { type: 'crmUser' as const, id: userId };
  return { type: 'org' as const, id: orgId };
};

const resolveOrganizer = async (userId: string) => {
  const user = await User.findById(userId).select('name fullName email');
  if (user) return { name: user.name || (user as any).fullName, email: user.email };

  const crmUser = await CrmUser.findById(userId).select('fullName email');
  if (crmUser) return { name: crmUser.fullName, email: crmUser.email };

  return null;
};

const checkUserAvailability = async (userId: string, startTime: Date, endTime: Date, excludeAppointmentId?: string) => {
  const filter: any = {
    participants: new mongoose.Types.ObjectId(userId),
    status: { $ne: 'cancelled' },
    transparency: { $ne: 'transparent' },
    $and: [
      { startTime: { $lt: endTime } },
      { endTime: { $gt: startTime } }
    ],
    $expr: {
      $lt: [
        { $subtract: ["$endTime", "$startTime"] },
        23 * 60 * 60 * 1000
      ]
    }
  };

  if (excludeAppointmentId) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeAppointmentId) };
  }

  const conflict = await Appointment.findOne(filter);
  if (conflict) {
    const timeStr = `${conflict.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${conflict.endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    throw new ApiError(409, `Double-Booking Conflict: You already have "${conflict.title}" scheduled for ${timeStr}.`);
  }
};

const createAppointment = async (userId: string, orgId: string, data: CreateAppointmentData) => {
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);

  if (start >= end) {
    throw new ApiError(400, 'End time must be after start time');
  }

  // Double-Booking Prevention
  await checkUserAvailability(userId, start, end);

  if (start < new Date()) {
    throw new ApiError(400, 'Cannot schedule appointments in the past');
  }

  const participants = [...new Set([userId, ...(data.participants ?? [])])];

  const guestEmails = (data.guestEmails || []).map(email => ({
    email: email.toLowerCase().trim(),
    status: 'pending' as const,
  }));

  let customerBooking = undefined;
  if (data.customerBooking?.isCustomerBooking) {
    customerBooking = {
      firstName: data.customerBooking.firstName.trim(),
      lastName: data.customerBooking.lastName.trim(),
      email: data.customerBooking.email.toLowerCase().trim(),
      phone: data.customerBooking.phone.trim(),
      isCustomerBooking: true,
      bookingHistory: {
        previousBookings: [],
        totalBookings: 1,
        lastBookedAt: new Date()
      }
    };
  }

  const isCrmUser = await CrmUser.exists({ _id: userId });
  const identityModel = isCrmUser ? 'CrmUser' : 'User';

  const appointment = await Appointment.create({
    ...data,
    createdBy: userId,
    createdByModel: identityModel,
    participantModel: identityModel,
    organizationId: orgId,
    participants,
    guestEmails,
    customerBooking,
    leadId: data.leadId ? new mongoose.Types.ObjectId(data.leadId) : undefined,
    status: 'scheduled',
    entryType: data.entryType || 'appointment'
  });

  const organizer = await resolveOrganizer(userId);

  if (!organizer) {
    throw new ApiError(404, 'Organizer not found');
  }

  console.log('Appointment created:', appointment._id);

  try {
    const target = await resolveCalendarTarget(userId, orgId);
    await googleCalendarService.syncAppointmentToGoogleCalendar(appointment, target);
    console.log(`Synced to ${target.type}'s Google Calendar`);
  } catch (error) {
    console.error('Failed to sync to Google Calendar:', error);
  }

  if (data.leadId) {
    await Lead.findByIdAndUpdate(data.leadId, {
      status: 'Appointment Set'
    });
  }

  if (customerBooking) {
    try {
      const token = jwt.sign(
        { appointmentId: appointment._id, email: customerBooking.email },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '30d' }
      );

      await emailService.sendAppointmentInvitation(
        appointment,
        organizer,
        customerBooking.email,
        token,
        appointment.organizationId.toString()
      );
      console.log(`✅ Sent customer booking invitation to ${customerBooking.email}`);
    } catch (error) {
      console.error(`❌ Failed to send customer booking invitation:`, error);
    }
  }

  // Send invitations to guest emails
  if (guestEmails.length > 0) {
    const invitationPromises = guestEmails.map(async (guest) => {
      try {
        const token = jwt.sign(
          { appointmentId: appointment._id, email: guest.email },
          process.env.JWT_SECRET || 'secret',
          { expiresIn: '30d' }
        );

        await emailService.sendAppointmentInvitation(
          appointment,
          organizer,
          guest.email,
          token,
          appointment.organizationId.toString()
        );
      } catch (error) {
        console.error(`Failed to send invitation to ${guest.email}:`, error);
      }
    });

    await Promise.allSettled(invitationPromises);
  }

  const participantIds = participants.filter(p => p !== userId);
  await Promise.all(
    participantIds.map(participantId =>
      notificationService.createNotification({
        userId: participantId,
        type: 'appointment_created',
        title: `New ${data.entryType.charAt(0).toUpperCase() + data.entryType.slice(1)}`,
        message: `You have been invited to "${data.title}" on ${start.toLocaleDateString()}`,
        metadata: {
          appointmentId: appointment._id,
          title: data.title,
          startTime: data.startTime,
          entryType: data.entryType,
          createdBy: userId
        },
        organizationId: orgId
      })
    )
  );

  if (customerBooking) {
    try {
      await customerBookingService.updateBookingHistory(appointment._id.toString());
    } catch (error) {
      console.error('Failed to update customer booking history:', error);
    }
  }

  // Senior Fix: Transition Lead to "Appointment Set"
  if (data.customerBooking?.isCustomerBooking || data.participants.length > 0) {
    try {
      // Look for a lead matching the email or context
      const leadEmail = data.customerBooking?.email || (data as any).email;
      if (leadEmail) {
        const updatedLead = await Lead.findOneAndUpdate(
          { email: leadEmail, organizationId: orgId },
          { status: 'Appointment Set' },
          { new: true }
        );
        if (updatedLead) {
          const io = getSocketIO();
          if (io) io.to(`org:${orgId}`).emit('lead:update', updatedLead);
        }
      }
    } catch (error) {
      console.error('Failed to transition lead to Appointment Set:', error);
    }
  }

  return appointment.populate('participants createdBy', 'name fullName email avatar');
};

// =============================================================================
// FIX: Safe ObjectId casting helper
// =============================================================================
const safeObjectId = (id: string): mongoose.Types.ObjectId | string => {
  try {
    if (mongoose.Types.ObjectId.isValid(id) && new mongoose.Types.ObjectId(id).toString() === id) {
      return new mongoose.Types.ObjectId(id);
    }
    return id;
  } catch {
    return id;
  }
};

const getUserAppointments = async (
  userId: string,
  orgId: string,
  options: {
    status?: string;
    entryType?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    skip?: number;
    includeCustomerBookings?: boolean;
    customerBookingsOnly?: boolean;
  } = {}
) => {
  const filter: any = {
    organizationId: orgId,
  };

  const userOid = safeObjectId(userId);
  filter.participants = userOid;

  if (options.status) {
    filter.status = options.status;
  }

  if (options.entryType) {
    filter.entryType = options.entryType;
  }

  if (options.customerBookingsOnly) {
    filter['customerBooking.isCustomerBooking'] = true;
  } else if (options.includeCustomerBookings === false) {
    filter['customerBooking.isCustomerBooking'] = { $ne: true };
  }

  if (options.startDate || options.endDate) {
    filter.startTime = {};
    if (options.startDate) filter.startTime.$gte = options.startDate;
    if (options.endDate) filter.startTime.$lte = options.endDate;
  }

  const appointments = await Appointment.find(filter)
    .populate('participants createdBy', 'name email avatar')
    .sort({ startTime: 1 })
    .limit(options.limit || 2500)
    .skip(options.skip || 0);

  const total = await Appointment.countDocuments(filter);

  return { appointments, total };
};

const getCustomerBookings = async (
  userId: string,
  orgId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
    status?: string;
  } = {}
) => {
  const filter: any = {
    organizationId: orgId,
    'customerBooking.isCustomerBooking': true
  };

  if (options.status) {
    filter.status = options.status;
  }

  if (options.startDate || options.endDate) {
    filter.startTime = {};
    if (options.startDate) filter.startTime.$gte = options.startDate;
    if (options.endDate) filter.startTime.$lte = options.endDate;
  }

  const appointments = await Appointment.find(filter)
    .populate('createdBy', 'name email avatar')
    .sort({ startTime: -1 });

  return { appointments, total: appointments.length };
};

const updateAppointment = async (
  appointmentId: string,
  orgId: string,
  userId: string,
  updateData: Partial<CreateAppointmentData & { status: string; outcomeNotes: string }>
) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('createdBy', 'name fullName email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  const isCreator = appointment.createdBy._id.toString() === userId;
  const isParticipant = appointment.participants.some(p => p.toString() === userId);

  if (!isCreator && !isParticipant) {
    throw new ApiError(403, 'Not authorized to update this appointment');
  }

  if (!isCreator && (updateData.participants || updateData.guestEmails)) {
    throw new ApiError(403, 'Only the creator can modify participants or guests');
  }

  Object.assign(appointment, updateData);
  console.log(`[AppointmentService] Saving appointment ${appointmentId}...`);
  await appointment.save();
  console.log(`[AppointmentService] Saved. Starting sync...`);

  try {
    const target = await resolveCalendarTarget(userId, orgId);
    console.log(`[AppointmentService] Syncing to Google Calendar for ${target.type} ${target.id}...`);
    await googleCalendarService.syncAppointmentToGoogleCalendar(appointment, target);
  } catch (error: any) {
    console.error('[AppointmentService] Failed to sync update to Google Calendar:', error.message);
  }

  console.log(`[AppointmentService] Notifying participants...`);
  const participantIds = appointment.participants
    .map(p => p.toString())
    .filter(p => p !== userId);

  await Promise.all(
    participantIds.map(participantId => {
      console.log(`[AppointmentService] Notifying participant ${participantId}...`);
      return notificationService.createNotification({
        userId: participantId,
        organizationId: appointment.organizationId,
        type: 'appointment_updated',
        title: `${appointment.entryType.charAt(0).toUpperCase() + appointment.entryType.slice(1)} Updated`,
        message: `"${appointment.title}" has been updated`,
        metadata: {
          appointmentId: appointment._id,
          title: appointment.title,
          entryType: appointment.entryType,
          updatedBy: userId
        }
      });
    })
  );

  console.log(`[AppointmentService] Sending emails...`);
  if (appointment.guestEmails.length > 0) {
    const organizer = await resolveOrganizer(appointment.createdBy._id.toString());
    if (organizer) {
      console.log(`[AppointmentService] Sending update to ${appointment.guestEmails.length} guests...`);
      await Promise.allSettled(
        appointment.guestEmails.map(guest =>
          emailService.sendAppointmentUpdate(appointment, organizer, guest.email)
        )
      );
    }
  }

  // Send update email to customer booking
  if (appointment.customerBooking?.isCustomerBooking) {
    const organizer = await resolveOrganizer(appointment.createdBy._id.toString());
    if (organizer) {
      try {
        console.log(`[AppointmentService] Sending update to customer ${appointment.customerBooking.email}...`);
        await emailService.sendAppointmentUpdate(appointment, organizer, appointment.customerBooking.email);
        console.log(`✅ Sent customer booking update to ${appointment.customerBooking.email}`);
      } catch (error) {
        console.error(`❌ Failed to send customer booking update:`, error);
      }
    }
  }

  console.log(`[AppointmentService] Update complete.`);
  return appointment.populate('participants createdBy', 'name email avatar');
};

const cancelAppointment = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('createdBy', 'name fullName email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  if (appointment.createdBy._id.toString() !== userId) {
    throw new ApiError(403, 'Only the creator can cancel this appointment');
  }

  appointment.status = 'cancelled';
  await appointment.save();

  if (appointment.googleCalendarEventId) {
    try {
      const target = await resolveCalendarTarget(appointment.createdBy._id.toString(), orgId);
      await googleCalendarService.deleteFromGoogleCalendar(
        appointment.googleCalendarEventId,
        target
      );
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  const participantIds = appointment.participants
    .map(p => p.toString())
    .filter(p => p !== userId);

  await Promise.all(
    participantIds.map(participantId =>
      notificationService.createNotification({
        userId: participantId,
        organizationId: appointment.organizationId,
        type: 'appointment_cancelled',
        title: `${appointment.entryType.charAt(0).toUpperCase() + appointment.entryType.slice(1)} Cancelled`,
        message: `"${appointment.title}" has been cancelled`,
        metadata: {
          appointmentId: appointment._id,
          title: appointment.title,
          entryType: appointment.entryType,
          cancelledBy: userId
        }
      })
    )
  );

  if (appointment.guestEmails.length > 0) {
    const organizer = await resolveOrganizer(appointment.createdBy._id.toString());
    if (organizer) {
      await Promise.allSettled(
        appointment.guestEmails.map(guest =>
          emailService.sendAppointmentCancellation(appointment, organizer, guest.email)
        )
      );
    }
  }

  // Send cancellation email to customer booking
  if (appointment.customerBooking?.isCustomerBooking) {
    const organizer = await resolveOrganizer(appointment.createdBy._id.toString());
    if (organizer) {
      try {
        await emailService.sendAppointmentCancellation(appointment, organizer, appointment.customerBooking.email);
        console.log(`✅ Sent customer booking cancellation to ${appointment.customerBooking.email}`);
      } catch (error) {
        console.error(`❌ Failed to send customer booking cancellation:`, error);
      }
    }
  }

  return appointment;
};

const deleteAppointment = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('createdBy', 'name fullName email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  if (appointment.createdBy._id.toString() !== userId) {
    throw new ApiError(403, 'Only the creator can delete this appointment');
  }

  console.log(`[AppointmentService] Deleting appointment ${appointmentId}...`);
  if (appointment.googleCalendarEventId) {
    try {
      const target = await resolveCalendarTarget(appointment.createdBy._id.toString(), orgId);
      console.log(`[AppointmentService] Deleting from Google Calendar for ${target.type} ${target.id}...`);
      await googleCalendarService.deleteFromGoogleCalendar(
        appointment.googleCalendarEventId,
        target
      );
    } catch (error: any) {
      console.error('[AppointmentService] Failed to delete from Google Calendar:', error.message);
    }
  }

  console.log(`[AppointmentService] Sending cancellation emails...`);
  if (appointment.guestEmails.length > 0) {
    const organizer = await resolveOrganizer(appointment.createdBy._id.toString());
    if (organizer) {
      console.log(`[AppointmentService] Notifying ${appointment.guestEmails.length} guests...`);
      await Promise.allSettled(
        appointment.guestEmails.map(guest =>
          emailService.sendAppointmentCancellation(appointment, organizer, guest.email)
        )
      );
    }
  }

  // Send cancellation email to customer booking
  if (appointment.customerBooking?.isCustomerBooking) {
    const organizer = await resolveOrganizer(appointment.createdBy._id.toString());
    if (organizer) {
      try {
        console.log(`[AppointmentService] Sending cancellation to customer ${appointment.customerBooking.email}...`);
        await emailService.sendAppointmentCancellation(appointment, organizer, appointment.customerBooking.email);
        console.log(`✅ Sent customer booking cancellation to ${appointment.customerBooking.email}`);
      } catch (error) {
        console.error(`❌ Failed to send customer booking cancellation:`, error);
      }
    }
  }

  console.log(`[AppointmentService] Removing from database...`);
  await Appointment.findByIdAndDelete(appointmentId);
  console.log(`[AppointmentService] Delete complete.`);
};

const getAppointmentById = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('participants createdBy', 'name email avatar')
    .populate('vehicleId')
    .populate('quoteId')
    .populate('shipmentId');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  const hasAccess =
    appointment.createdBy._id.toString() === userId ||
    appointment.participants.some((p: any) => p._id.toString() === userId);

  if (!hasAccess) {
    throw new ApiError(403, 'Not authorized to view this appointment');
  }

  return appointment;
};

const handleGuestResponse = async (
  appointmentId: string,
  token: string,
  status: 'accepted' | 'declined',
  googleAccessToken?: string
) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;

    if (decoded.appointmentId !== appointmentId) {
      throw new ApiError(403, 'Invalid token for this appointment');
    }

    const appointment = await Appointment.findById(appointmentId);

    if (!appointment) {
      throw new ApiError(404, 'Appointment not found');
    }

    const guestIndex = appointment.guestEmails.findIndex(
      g => g.email === decoded.email
    );

    if (guestIndex === -1) {
      throw new ApiError(404, 'Guest not found in appointment');
    }

    appointment.guestEmails[guestIndex].status = status;
    appointment.guestEmails[guestIndex].respondedAt = new Date();

    if (status === 'accepted' && googleAccessToken) {
      try {
        const organizerId = (appointment.createdBy as any)._id?.toString() || appointment.createdBy.toString();
        const target = await resolveCalendarTarget(organizerId, appointment.organizationId.toString());
        const eventId = await googleCalendarService.syncAppointmentToGoogleCalendar(
          appointment,
          target
        );
        if (eventId) {
          appointment.guestEmails[guestIndex].googleCalendarEventId = eventId;
        }
      } catch (error) {
        console.error('Failed to create Google Calendar event:', error);
      }
    }

    await appointment.save();

    const organizerId = (appointment.createdBy as any)._id?.toString() || appointment.createdBy.toString();
    await notificationService.createNotification({
      userId: organizerId,
      organizationId: appointment.organizationId.toString(),
      type: 'guest_response',
      title: 'Guest Response',
      message: `${decoded.email} has ${status} your invitation to "${appointment.title}"`,
      metadata: {
        appointmentId: appointment._id,
        guestEmail: decoded.email,
        status
      }
    });

    return appointment;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new ApiError(403, 'Invalid or expired token');
    }
    throw error;
  }
};

const removeDuplicateAppointments = async (): Promise<number> => {
  try {
    const duplicates = await Appointment.aggregate([
      {
        $match: {
          googleCalendarEventId: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: '$googleCalendarEventId',
          count: { $sum: 1 },
          ids: { $push: '$_id' },
          dates: { $push: '$createdAt' }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]);

    let removedCount = 0;

    for (const duplicate of duplicates) {
      const sortedIds = duplicate.ids
        .map((id: any, index: number) => ({
          id,
          date: duplicate.dates[index]
        }))
        .sort((a: any, b: any) => a.date - b.date);

      for (let i = 1; i < sortedIds.length; i++) {
        await Appointment.findByIdAndDelete(sortedIds[i].id);
        removedCount++;
      }
    }

    console.log(`Removed ${removedCount} duplicate appointments`);
    return removedCount;
  } catch (error) {
    console.error('Failed to remove duplicate appointments:', error);
    return 0;
  }
};

export default {
  createAppointment,
  getUserAppointments,
  getCustomerBookings,
  getAppointmentById,
  updateAppointment,
  cancelAppointment,
  deleteAppointment,
  handleGuestResponse,
  removeDuplicateAppointments,
  checkUserAvailability
};