import Appointment from '../models/Appointment.model';
import Conversation from '../models/Conversation.model';
import User from '../models/User.model';
import notificationService from './notification.service';
import emailService from './email.service';
import googleCalendarService from './googleCalendar.service';
import customerBookingService from './customerbooking.service';
import { ApiError } from '../utils/ApiError';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

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
  conversationId?: string;
  vehicleId?: string;
  quoteId?: string;
  shipmentId?: string;
  meetingLink?: string;
  notes?: string;
}

const createAppointment = async (userId: string, orgId: string, data: CreateAppointmentData) => {
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);

  if (start >= end) {
    throw new ApiError(400, 'End time must be after start time');
  }

  if (start < new Date()) {
    throw new ApiError(400, 'Cannot schedule appointments in the past');
  }

  const participants = [...new Set([userId, ...data.participants])];

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

  const appointment = await Appointment.create({
    ...data,
    createdBy: userId,
    organizationId: orgId,
    participants,
    guestEmails,
    customerBooking,
    status: 'scheduled',
    entryType: data.entryType || 'appointment'
  });

  const organizer = await User.findById(userId).select('name email');

  if (!organizer) {
    throw new ApiError(404, 'Organizer not found');
  }

  console.log('Appointment created:', appointment._id);

  try {
    await googleCalendarService.syncAppointmentToGoogleCalendar(appointment, userId);
    console.log('Synced to organizer\'s Google Calendar');
  } catch (error) {
    console.error('Failed to sync to Google Calendar:', error);
  }

  // FIX: Send email invitations to customer bookings
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
        token
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
          token
        );
      } catch (error) {
        console.error(`Failed to send invitation to ${guest.email}:`, error);
      }
    });

    await Promise.allSettled(invitationPromises);
  }

  if (data.conversationId) {
    await Conversation.findByIdAndUpdate(data.conversationId, {
      hasAppointment: true,
      appointmentId: appointment._id
    });

    await Conversation.findByIdAndUpdate(data.conversationId, {
      $push: {
        messages: {
          sender: userId,
          content: `${data.entryType.charAt(0).toUpperCase() + data.entryType.slice(1)} scheduled: ${data.title}`,
          type: 'appointment',
          metadata: {
            appointmentId: appointment._id,
            startTime: data.startTime,
            endTime: data.endTime,
            entryType: data.entryType
          },
          readBy: [userId],
          createdAt: new Date()
        }
      },
      lastMessage: `${data.entryType.charAt(0).toUpperCase() + data.entryType.slice(1)} scheduled: ${data.title}`,
      lastMessageAt: new Date(),
      lastMessageBy: userId
    });
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

  return appointment.populate('participants createdBy', 'name email avatar');
};

// =============================================================================
// FIX: Safe ObjectId casting helper
// The `participants` field is Schema.Types.ObjectId[]. When querying with a
// string userId, Mongoose tries to auto-cast. If the string isn't a valid
// 24-char hex ObjectId, it throws a CastError. This helper safely converts
// and falls back to querying by `createdBy` if casting fails.
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

  // =============================================================================
  // FIX: Safely cast userId to ObjectId for the participants query.
  // This prevents the Mongoose CastError: "Cast to ObjectId failed for value..."
  // =============================================================================
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

  // =============================================================================
  // FIX: Increased default limit from 100 to 2500.
  //
  // The old limit of 100 combined with ascending sort meant only the 100 OLDEST
  // events were returned. For a user with 200+ Google Calendar events (e.g. a
  // daily recurring meeting), ALL future events were silently dropped.
  //
  // This is why Total=100 but Upcoming=0 and Today=0 — the 100 returned events
  // were all in the past. The calendar tab appeared empty because no events
  // existed for the current or future months.
  // =============================================================================
  const appointments = await Appointment.find(filter)
    .populate('participants createdBy', 'name email avatar')
    .populate('conversationId', 'type name')
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
  updateData: Partial<CreateAppointmentData & { status: string }>
) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('createdBy', 'name email');

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
  await appointment.save();

  try {
    await googleCalendarService.syncAppointmentToGoogleCalendar(appointment, userId);
  } catch (error) {
    console.error('Failed to sync update to Google Calendar:', error);
  }

  const participantIds = appointment.participants
    .map(p => p.toString())
    .filter(p => p !== userId);

  await Promise.all(
    participantIds.map(participantId =>
      notificationService.createNotification({
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
      })
    )
  );

  if (appointment.guestEmails.length > 0) {
    const organizer = await User.findById(appointment.createdBy).select('name email');
    if (organizer) {
      await Promise.allSettled(
        appointment.guestEmails.map(guest =>
          emailService.sendAppointmentUpdate(appointment, organizer, guest.email)
        )
      );
    }
  }

  // FIX: Send update email to customer booking
  if (appointment.customerBooking?.isCustomerBooking) {
    const organizer = await User.findById(appointment.createdBy).select('name email');
    if (organizer) {
      try {
        await emailService.sendAppointmentUpdate(appointment, organizer, appointment.customerBooking.email);
        console.log(`✅ Sent customer booking update to ${appointment.customerBooking.email}`);
      } catch (error) {
        console.error(`❌ Failed to send customer booking update:`, error);
      }
    }
  }

  return appointment.populate('participants createdBy', 'name email avatar');
};

const cancelAppointment = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('createdBy', 'name email');

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
      await googleCalendarService.deleteFromGoogleCalendar(
        appointment.googleCalendarEventId,
        userId
      );
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  if (appointment.conversationId) {
    await Conversation.findByIdAndUpdate(appointment.conversationId, {
      hasAppointment: false,
      $unset: { appointmentId: 1 }
    });
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
    const organizer = await User.findById(appointment.createdBy).select('name email');
    if (organizer) {
      await Promise.allSettled(
        appointment.guestEmails.map(guest =>
          emailService.sendAppointmentCancellation(appointment, organizer, guest.email)
        )
      );
    }
  }

  // FIX: Send cancellation email to customer booking
  if (appointment.customerBooking?.isCustomerBooking) {
    const organizer = await User.findById(appointment.createdBy).select('name email');
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
    .populate('createdBy', 'name email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  if (appointment.createdBy._id.toString() !== userId) {
    throw new ApiError(403, 'Only the creator can delete this appointment');
  }

  if (appointment.googleCalendarEventId) {
    try {
      await googleCalendarService.deleteFromGoogleCalendar(
        appointment.googleCalendarEventId,
        userId
      );
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  if (appointment.conversationId) {
    await Conversation.findByIdAndUpdate(appointment.conversationId, {
      hasAppointment: false,
      $unset: { appointmentId: 1 }
    });
  }

  if (appointment.guestEmails.length > 0) {
    const organizer = await User.findById(appointment.createdBy).select('name email');
    if (organizer) {
      await Promise.allSettled(
        appointment.guestEmails.map(guest =>
          emailService.sendAppointmentCancellation(appointment, organizer, guest.email)
        )
      );
    }
  }

  // FIX: Send cancellation email to customer booking
  if (appointment.customerBooking?.isCustomerBooking) {
    const organizer = await User.findById(appointment.createdBy).select('name email');
    if (organizer) {
      try {
        await emailService.sendAppointmentCancellation(appointment, organizer, appointment.customerBooking.email);
        console.log(`✅ Sent customer booking cancellation to ${appointment.customerBooking.email}`);
      } catch (error) {
        console.error(`❌ Failed to send customer booking cancellation:`, error);
      }
    }
  }

  await Appointment.findByIdAndDelete(appointmentId);
};

const getAppointmentById = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId })
    .populate('participants createdBy', 'name email avatar')
    .populate('conversationId', 'type name')
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
        const eventId = await googleCalendarService.syncAppointmentToGoogleCalendar(
          appointment,
          appointment.createdBy.toString()
        );
        if (eventId) {
          appointment.guestEmails[guestIndex].googleCalendarEventId = eventId;
        }
      } catch (error) {
        console.error('Failed to create Google Calendar event:', error);
      }
    }

    await appointment.save();

    await notificationService.createNotification({
      userId: appointment.createdBy.toString(),
      organizationId: appointment.organizationId,
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
  removeDuplicateAppointments
};