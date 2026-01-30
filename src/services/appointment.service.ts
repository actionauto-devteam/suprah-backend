import Appointment from '../models/Appointment.model';
import Conversation from '../models/Conversation.model';
import notificationService from './notification.service';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';

interface CreateAppointmentData {
    title: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    location?: string;
    type: 'in-person' | 'phone' | 'video' | 'other';
    participants: string[];
    conversationId?: string;
    vehicleId?: string;
    quoteId?: string;
    shipmentId?: string;
    notes?: string;
}

/**
 * Create a new appointment
 */
const createAppointment = async (userId: string, data: CreateAppointmentData) => {
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
    const participants = [...new Set([userId, ...data.participants])];
    
    // Create appointment
    const appointment = await Appointment.create({
        ...data,
        createdBy: userId,
        participants,
        status: 'scheduled'
    });
    
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
                    content: `Appointment scheduled: ${data.title}`,
                    type: 'appointment',
                    metadata: {
                        appointmentId: appointment._id,
                        startTime: data.startTime,
                        endTime: data.endTime
                    },
                    readBy: [userId],
                    createdAt: new Date()
                }
            },
            lastMessage: `Appointment scheduled: ${data.title}`,
            lastMessageAt: new Date(),
            lastMessageBy: userId
        });
    }
    
    // Notify all participants
    const participantIds = participants.filter(p => p !== userId);
    await Promise.all(
        participantIds.map(participantId =>
            notificationService.createNotification({
                userId: participantId,
                type: 'appointment_created',
                title: 'New Appointment',
                message: `You have been invited to "${data.title}" on ${start.toLocaleDateString()}`,
                metadata: {
                    appointmentId: appointment._id,
                    title: data.title,
                    startTime: data.startTime,
                    createdBy: userId
                }
            })
        )
    );
    
    return appointment.populate('participants createdBy', 'name email avatar');
};

/**
 * Get user's appointments
 */
const getUserAppointments = async (
    userId: string,
    options: {
        status?: string;
        startDate?: Date;
        endDate?: Date;
        limit?: number;
        skip?: number;
    } = {}
) => {
    const filter: any = {
        participants: userId
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
    userId: string,
    updateData: Partial<CreateAppointmentData & { status: string }>
) => {
    const appointment = await Appointment.findById(appointmentId);
    
    if (!appointment) {
        throw new ApiError(404, 'Appointment not found');
    }
    
    // Check if user is creator or participant
    const isCreator = appointment.createdBy.toString() === userId;
    const isParticipant = appointment.participants.some(p => p.toString() === userId);
    
    if (!isCreator && !isParticipant) {
        throw new ApiError(403, 'Not authorized to update this appointment');
    }
    
    // Update appointment
    Object.assign(appointment, updateData);
    await appointment.save();
    
    // Notify participants about update
    const participantIds = appointment.participants
        .map(p => p.toString())
        .filter(p => p !== userId);
    
    await Promise.all(
        participantIds.map(participantId =>
            notificationService.createNotification({
                userId: participantId,
                type: 'appointment_updated',
                title: 'Appointment Updated',
                message: `"${appointment.title}" has been updated`,
                metadata: {
                    appointmentId: appointment._id,
                    title: appointment.title,
                    updatedBy: userId
                }
            })
        )
    );
    
    return appointment.populate('participants createdBy', 'name email avatar');
};

/**
 * Cancel appointment
 */
const cancelAppointment = async (appointmentId: string, userId: string) => {
    const appointment = await Appointment.findById(appointmentId);
    
    if (!appointment) {
        throw new ApiError(404, 'Appointment not found');
    }
    
    // Only creator can cancel
    if (appointment.createdBy.toString() !== userId) {
        throw new ApiError(403, 'Only the creator can cancel this appointment');
    }
    
    appointment.status = 'cancelled';
    await appointment.save();
    
    // Update conversation if linked
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
                type: 'appointment_cancelled',
                title: 'Appointment Cancelled',
                message: `"${appointment.title}" has been cancelled`,
                metadata: {
                    appointmentId: appointment._id,
                    title: appointment.title,
                    cancelledBy: userId
                }
            })
        )
    );
    
    return appointment;
};

/**
 * Delete appointment
 */
const deleteAppointment = async (appointmentId: string, userId: string) => {
    const appointment = await Appointment.findById(appointmentId);
    
    if (!appointment) {
        throw new ApiError(404, 'Appointment not found');
    }
    
    if (appointment.createdBy.toString() !== userId) {
        throw new ApiError(403, 'Only the creator can delete this appointment');
    }
    
    // Update conversation if linked
    if (appointment.conversationId) {
        await Conversation.findByIdAndUpdate(appointment.conversationId, {
            hasAppointment: false,
            $unset: { appointmentId: 1 }
        });
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
        // Keep the first one, delete the rest
        const [keep, ...remove] = dup.ids;
        await Appointment.deleteMany({ _id: { $in: remove } });
        removedCount += remove.length;
    }
    
    return removedCount;
};

export default {
    createAppointment,
    getUserAppointments,
    updateAppointment,
    cancelAppointment,
    deleteAppointment,
    removeDuplicateAppointments
};