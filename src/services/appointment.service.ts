import Appointment from '../models/Appointment.model';
import Conversation from '../models/Conversation.model';
import User, { IUser } from '../models/User.model';
import notificationService from './notification.service';
import emailService from './email.service';
import googleCalendarService from './googleCalendar.service';
import { ApiError } from '../utils/ApiError';
import jwt from 'jsonwebtoken';

interface IUserWithGoogleCalendar extends IUser {
  googleCalendar?: {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    connectedAt?: Date;
    watchChannelId?: string;
    watchResourceId?: string;
    watchExpiration?: Date;
  };
}

interface CreateAppointmentData {
  title: string;
  description?: string;
  startTime: Date | string;
  endTime: Date | string;
  location?: string;
  type: 'in-person' | 'phone' | 'video' | 'other';
  entryType: 'event' | 'task' | 'reminder' | 'appointment';
  participants: string[];
  guestEmails?: string[];
  conversationId?: string;
  vehicleId?: string;
  quoteId?: string;
  shipmentId?: string;
  meetingLink?: string;
  notes?: string;
}

/**
 * Create a new appointment with Google Calendar integration
 */
const createAppointment = async (userId: string, orgId: string, data: CreateAppointmentData) => {
  // Validate times
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);

  if (start >= end) {
    throw new ApiError(400, 'End time must be after start time');
  }

  if (start < new Date()) {
    throw new ApiError(400, 'Cannot schedule appointments in the past');
  }

  // Ensure creator is in participants
  const participants = [...new Set([userId, ...(data.participants || [])])];

  // Prepare guest emails with pending status
  const guestEmails = (data.guestEmails || []).map(email => ({
    email: email.toLowerCase().trim(),
    status: 'pending' as const,
  }));

  // Create appointment
  const appointment = await Appointment.create({
    ...data,
    createdBy: userId,
    organizationId: orgId,
    participants,
    guestEmails,
    status: 'scheduled',
    entryType: data.entryType || 'appointment'
  });
  
  const organizer = await User.findById(userId).select('name email googleCalendar') as IUserWithGoogleCalendar | null;
  
  if (!organizer) {
    throw new ApiError(404, 'Organizer not found');
  }
  
  console.log('Organizer details:', { name: organizer.name, email: organizer.email });
  
  if (organizer.googleCalendar?.connected) {
    try {
      const eventId = await googleCalendarService.createEventForOrganizer(appointment, userId);
      if (eventId) {
        appointment.googleCalendarEventId = eventId;
        await appointment.save();
        console.log('Created Google Calendar event for organizer');
      }
    } catch (error) {
      console.error('Failed to create organizer calendar event (non-critical):', error);
    }
  }
  
  if (guestEmails.length > 0) {
    const invitationPromises = guestEmails.map(async (guest: { email: string; status: string }) => {
      try {
        const token = jwt.sign(
          { appointmentId: appointment._id, email: guest.email },
          process.env.JWT_SECRET || 'secret',
          { expiresIn: '90d' }
        );

        await emailService.sendAppointmentInvitation(
          appointment,
          organizer,
          guest.email,
          token
        );
        
        console.log(`Sent invitation email to ${guest.email}`);
      } catch (error) {
        console.error(`Failed to send invitation to ${guest.email}:`, error);
      }
    });

    await Promise.allSettled(invitationPromises);
  }

  // Link to conversation if provided
  if (data.conversationId) {
    await Conversation.findByIdAndUpdate(data.conversationId, {
      hasAppointment: true,
      appointmentId: appointment._id
    });

    // Add appointment message to conversation
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

  // Notify all registered participants
  const participantIds = participants.filter(p => p !== userId);
  await Promise.all(
    participantIds.map(participantId =>
      notificationService.createNotification({
        userId: participantId,
        organizationId: orgId,
        type: 'appointment_created',
        title: `New ${data.entryType.charAt(0).toUpperCase() + data.entryType.slice(1)}`,
        message: `You have been invited to "${data.title}" on ${start.toLocaleDateString()}`,
        metadata: {
          appointmentId: appointment._id,
          title: data.title,
          startTime: data.startTime,
          entryType: data.entryType,
          createdBy: userId
        }
      })
    )
  );

  return appointment.populate('participants createdBy', 'name email avatar');
};

/**
 * Handle guest response to appointment invitation
 * NOW WITH GUEST INFORMATION COLLECTION
 */
const handleGuestResponse = async (
  appointmentId: string,
  token: string,
  status: 'accepted' | 'declined',
  guestInfo?: {
    guestName?: string;
    guestPhone?: string;
  }
) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;

    if (decoded.appointmentId !== appointmentId) {
      throw new ApiError(403, 'Invalid token for this appointment');
    }
    
    const appointment = await Appointment.findById(appointmentId)
      .populate('createdBy', 'name email');
    
    if (!appointment) {
      throw new ApiError(404, 'Appointment not found');
    }
    
    const guestIndex = appointment.guestEmails.findIndex(
      g => g.email === decoded.email
    );

    if (guestIndex === -1) {
      throw new ApiError(404, 'Guest not found in appointment');
    }
    
    const previousStatus = appointment.guestEmails[guestIndex].status;
    appointment.guestEmails[guestIndex].status = status;
    appointment.guestEmails[guestIndex].respondedAt = new Date();
    
    if (guestInfo?.guestName) {
      appointment.guestEmails[guestIndex].guestName = guestInfo.guestName;
    }
    if (guestInfo?.guestPhone) {
      appointment.guestEmails[guestIndex].guestPhone = guestInfo.guestPhone;
    }

    await appointment.save();
    
    const guestDisplayName = guestInfo?.guestName || decoded.email;
    const notificationMessage = status === 'accepted' 
      ? `${guestDisplayName} has accepted your invitation to "${appointment.title}"`
      : `${guestDisplayName} has declined your invitation to "${appointment.title}"`;
    
    await notificationService.createNotification({
      userId: appointment.createdBy._id.toString(),
      organizationId: appointment.organizationId,
      type: 'guest_response',
      title: `Guest Response - ${status === 'accepted' ? 'Accepted' : 'Declined'}`,
      message: notificationMessage,
      metadata: {
        appointmentId: appointment._id,
        guestEmail: decoded.email,
        guestName: guestInfo?.guestName,
        guestPhone: guestInfo?.guestPhone,
        status,
        previousStatus,
        respondedAt: new Date()
      }
    });
    
    if (previousStatus !== 'pending' && previousStatus !== status) {
      await notificationService.createNotification({
        userId: appointment.createdBy._id.toString(),
        type: 'guest_response',
        title: 'Guest Changed Response',
        message: `${guestDisplayName} changed their response from ${previousStatus} to ${status} for "${appointment.title}"`,
        metadata: {
          appointmentId: appointment._id,
          guestEmail: decoded.email,
          guestName: guestInfo?.guestName,
          status,
          previousStatus,
          changed: true
        }
      });
    }
    
    console.log(`Guest ${decoded.email} ${status} invitation, notification sent to organizer`);
    
    return appointment;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new ApiError(403, 'Invalid or expired token');
    }
    throw error;
  }
};

/**
 * Get appointment by ID with full details
 */
const getAppointmentById = async (appointmentId: string, orgId: string) => {
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

/**
 * Get user's appointments with filtering
 */
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
  } = {}
) => {
  const filter: any = {
    organizationId: orgId,
    participants: userId
  };

  if (options.status) {
    filter.status = options.status;
  }

  if (options.entryType) {
    filter.entryType = options.entryType;
  }

  if (options.startDate || options.endDate) {
    filter.startTime = {};
    if (options.startDate) filter.startTime.$gte = options.startDate;
    if (options.endDate) filter.startTime.$lte = options.endDate;
  }

  const appointments = await Appointment.find(filter)
    .populate('participants createdBy', 'name email avatar')
    .populate('conversationId', 'type name')
    .sort({ startTime: 1 })
    .limit(options.limit || 100)
    .skip(options.skip || 0);

  const total = await Appointment.countDocuments(filter);

  return { appointments, total };
};

/**
 * Update appointment
 */
const updateAppointment = async (
  appointmentId: string,
  orgId: string,
  userId: string,
  updateData: Partial<CreateAppointmentData & { status: string }>
) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId }).populate('createdBy', 'name email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  // Check if user is creator or participant
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
  
  if (isCreator && appointment.googleCalendarEventId) {
    try {
      await googleCalendarService.updateEvent(
        appointment.googleCalendarEventId,
        appointment,
        userId
      );
      console.log('Updated Google Calendar event');
    } catch (error) {
      console.error('Failed to update Google Calendar event (non-critical):', error);
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

  // Notify guests via email
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

  return appointment.populate('participants createdBy', 'name email avatar');
};

/**
 * Cancel appointment
 */
const cancelAppointment = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId }).populate('createdBy', 'name email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  // Only creator can cancel
  if (appointment.createdBy._id.toString() !== userId) {
    throw new ApiError(403, 'Only the creator can cancel this appointment');
  }

  appointment.status = 'cancelled';
  await appointment.save();
  
  if (appointment.googleCalendarEventId) {
    try {
      await googleCalendarService.deleteEvent(appointment.googleCalendarEventId, userId);
      console.log('Deleted Google Calendar event');
    } catch (error) {
      console.error('Failed to delete Google Calendar event (non-critical):', error);
    }
  }
  
  if (appointment.conversationId) {
    await Conversation.findByIdAndUpdate(appointment.conversationId, {
      hasAppointment: false,
      $unset: { appointmentId: 1 }
    });
  }

  // Notify participants
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

  // Notify external guests via email
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

  return appointment;
};

/**
 * Delete appointment
 */
const deleteAppointment = async (appointmentId: string, orgId: string, userId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId: orgId }).populate('createdBy', 'name email');

  if (!appointment) {
    throw new ApiError(404, 'Appointment not found');
  }

  if (appointment.createdBy._id.toString() !== userId) {
    throw new ApiError(403, 'Only the creator can delete this appointment');
  }
  
  if (appointment.googleCalendarEventId) {
    try {
      await googleCalendarService.deleteEvent(appointment.googleCalendarEventId, userId);
    } catch (error) {
      console.error('Failed to delete Google Calendar event (non-critical):', error);
    }
  }
  
  if (appointment.conversationId) {
    await Conversation.findByIdAndUpdate(appointment.conversationId, {
      hasAppointment: false,
      $unset: { appointmentId: 1 }
    });
  }

  // Notify external guests via email about cancellation before deleting
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

  await Appointment.findByIdAndDelete(appointmentId);
};

/**
 * Remove duplicate appointments (automated cleanup)
 */
const removeDuplicateAppointments = async () => {
  const duplicates = await Appointment.aggregate([
    {
      $group: {
        _id: {
          title: '$title',
          startTime: '$startTime',
          createdBy: '$createdBy'
        },
        ids: { $push: '$_id' },
        count: { $sum: 1 }
      }
    },
    {
      $match: { count: { $gt: 1 } }
    }
  ]);

  let removedCount = 0;

  for (const dup of duplicates) {
    const [keep, ...remove] = dup.ids;
    await Appointment.deleteMany({ _id: { $in: remove } });
    removedCount += remove.length;
  }

  return removedCount;
};

/**
 * Send appointment reminders (can be called by a cron job)
 */
const sendAppointmentReminders = async () => {
  const tomorrow = new Date();
  tomorrow.setHours(tomorrow.getHours() + 24);

  const appointments = await Appointment.find({
    startTime: {
      $gte: new Date(),
      $lte: tomorrow
    },
    reminderSent: false,
    status: { $in: ['scheduled', 'confirmed'] }
  }).populate('participants createdBy', 'name email');

  let sentCount = 0;

  for (const appointment of appointments) {
    try {
      for (const participant of appointment.participants as any[]) {
        try {
          await emailService.sendAppointmentReminder(
            appointment,
            participant.email,
            participant.name
          );
        } catch (error) {
          console.error(`Failed to send reminder to ${participant.email}:`, error);
        }
      }

      // Send to external guests
      for (const guest of appointment.guestEmails) {
        if (guest.status === 'accepted') {
          try {
            const guestName = guest.guestName || guest.email.split('@')[0];
            await emailService.sendAppointmentReminder(
              appointment,
              guest.email,
              guestName
            );
          } catch (error) {
            console.error(`Failed to send reminder to ${guest.email}:`, error);
          }
        }
      }

      // Mark reminder as sent
      appointment.reminderSent = true;
      await appointment.save();

      sentCount++;
    } catch (error) {
      console.error(`Failed to send reminders for appointment ${appointment._id}:`, error);
    }
  }

  return sentCount;
};

/**
 * Mark past appointments as completed (can be called by a cron job)
 */
const markPastAppointmentsCompleted = async () => {
  const result = await Appointment.updateMany(
    {
      endTime: { $lt: new Date() },
      status: { $in: ['scheduled', 'confirmed'] }
    },
    {
      $set: { status: 'completed' }
    }
  );

  return result.modifiedCount;
};

export default {
  createAppointment,
  getUserAppointments,
  getAppointmentById,
  updateAppointment,
  cancelAppointment,
  deleteAppointment,
  handleGuestResponse,
  removeDuplicateAppointments,
  sendAppointmentReminders,
  markPastAppointmentsCompleted
};