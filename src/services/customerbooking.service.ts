import Appointment from '../models/Appointment.model';
import { ApiError } from '../utils/ApiError';

interface CustomerBookingData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  organizationId?: string;
}

interface DuplicateCheckResult {
  isDuplicate: boolean;
  reason?: string;
  existingBooking?: any;
}

class CustomerBookingService {
  /**
   * Normalize phone number for comparison
   */
  private normalizePhone(phone: string): string {
    return phone.replace(/[\s\-\(\)]/g, '');
  }

  /**
   * Normalize name for comparison
   */
  private normalizeName(name: string): string {
    return name.toLowerCase().trim();
  }

  /**
   * Check if customer booking is duplicate
   */
  async checkDuplicateBooking(
    customerData: CustomerBookingData,
    requestedStartTime: Date,
    excludeAppointmentId?: string
  ): Promise<DuplicateCheckResult> {
    const normalizedFirstName = this.normalizeName(customerData.firstName);
    const normalizedLastName = this.normalizeName(customerData.lastName);
    const normalizedEmail = customerData.email.toLowerCase().trim();
    const normalizedPhone = this.normalizePhone(customerData.phone);

    // Find all active bookings for this customer within this organization
    const query: any = {
      organizationId: customerData.organizationId, // Required field
      'customerBooking.isCustomerBooking': true,
      status: { $in: ['scheduled', 'confirmed'] },
      startTime: { $gte: new Date() }, // Only check future bookings
    };

    if (excludeAppointmentId) {
      query._id = { $ne: excludeAppointmentId };
    }

    // Build OR conditions for duplicate detection
    const orConditions = [];

    // Condition 1: Same name + same email
    orConditions.push({
      'customerBooking.email': normalizedEmail,
      $expr: {
        $and: [
          { $eq: [{ $toLower: '$customerBooking.firstName' }, normalizedFirstName] },
          { $eq: [{ $toLower: '$customerBooking.lastName' }, normalizedLastName] }
        ]
      }
    });

    // Condition 2: Same name + same phone
    orConditions.push({
      $expr: {
        $and: [
          { $eq: [{ $toLower: '$customerBooking.firstName' }, normalizedFirstName] },
          { $eq: [{ $toLower: '$customerBooking.lastName' }, normalizedLastName] },
          {
            $eq: [
              { $replaceAll: { input: '$customerBooking.phone', find: ' ', replacement: '' } },
              normalizedPhone.replace(/[\-\(\)]/g, '')
            ]
          }
        ]
      }
    });

    // Condition 3: Same name + same phone + same email
    orConditions.push({
      'customerBooking.email': normalizedEmail,
      $expr: {
        $and: [
          { $eq: [{ $toLower: '$customerBooking.firstName' }, normalizedFirstName] },
          { $eq: [{ $toLower: '$customerBooking.lastName' }, normalizedLastName] },
          {
            $eq: [
              { $replaceAll: { input: '$customerBooking.phone', find: ' ', replacement: '' } },
              normalizedPhone.replace(/[\-\(\)]/g, '')
            ]
          }
        ]
      }
    });

    query.$or = orConditions;

    const existingBookings = await Appointment.find(query)
      .populate('createdBy', 'name email')
      .sort({ startTime: 1 });

    if (existingBookings.length > 0) {
      const booking = existingBookings[0];
      const bookedBy = (booking.createdBy as any).name || 'Another organizer';

      return {
        isDuplicate: true,
        reason: `This customer already has an active booking scheduled for ${booking.startTime.toLocaleString()} with ${bookedBy}. Customers can only be rebooked after their previous appointment has passed.`,
        existingBooking: booking
      };
    }

    return { isDuplicate: false };
  }

  /**
   * Get customer booking history
   */
  async getCustomerHistory(
    orgId: string,
    email?: string,
    phone?: string,
    firstName?: string,
    lastName?: string
  ) {
    const query: any = {
      organizationId: orgId,
      'customerBooking.isCustomerBooking': true
    };

    const conditions = [];

    if (email) {
      conditions.push({ 'customerBooking.email': email.toLowerCase().trim() });
    }

    if (phone) {
      const normalizedPhone = this.normalizePhone(phone);
      // This is a simplified match - in production you might want regex
      conditions.push({
        $expr: {
          $eq: [
            { $replaceAll: { input: '$customerBooking.phone', find: ' ', replacement: '' } },
            normalizedPhone.replace(/[\-\(\)]/g, '')
          ]
        }
      });
    }

    if (firstName && lastName) {
      conditions.push({
        $expr: {
          $and: [
            { $eq: [{ $toLower: '$customerBooking.firstName' }, firstName.toLowerCase().trim()] },
            { $eq: [{ $toLower: '$customerBooking.lastName' }, lastName.toLowerCase().trim()] }
          ]
        }
      });
    }

    if (conditions.length > 0) {
      query.$or = conditions;
    } else {
      throw new ApiError(400, 'At least one search criteria is required');
    }

    const bookings = await Appointment.find(query)
      .populate('createdBy', 'name email avatar')
      .sort({ startTime: -1 });

    // Calculate statistics
    const totalBookings = bookings.length;
    const upcomingBookings = bookings.filter(b => new Date(b.startTime) > new Date()).length;
    const completedBookings = bookings.filter(b => b.status === 'completed').length;
    const cancelledBookings = bookings.filter(b => b.status === 'cancelled').length;
    const bookedByMap = new Map<string, { organizerId: string; organizerName: string; count: number }>();

    bookings.forEach(booking => {
      const organizerId = (booking.createdBy as any)?._id?.toString?.() || (booking.createdBy as any)?.email || 'unknown';
      const organizerName = (booking.createdBy as any)?.name || (booking.createdBy as any)?.email || 'Unknown';
      const existing = bookedByMap.get(organizerId);
      if (existing) {
        existing.count += 1;
      } else {
        bookedByMap.set(organizerId, { organizerId, organizerName, count: 1 });
      }
    });

    return {
      customer: bookings[0]?.customerBooking
        ? {
            firstName: bookings[0].customerBooking.firstName,
            lastName: bookings[0].customerBooking.lastName,
            email: bookings[0].customerBooking.email,
            phone: bookings[0].customerBooking.phone,
          }
        : email || phone || firstName || lastName
          ? {
              firstName: firstName || bookings[0]?.customerBooking?.firstName || '',
              lastName: lastName || bookings[0]?.customerBooking?.lastName || '',
              email: email || bookings[0]?.customerBooking?.email || '',
              phone: phone || bookings[0]?.customerBooking?.phone || '',
            }
          : null,
      bookings,
      statistics: {
        total: totalBookings,
        totalBookings,
        upcoming: upcomingBookings,
        upcomingBookings,
        completed: completedBookings,
        completedBookings,
        cancelled: cancelledBookings,
        cancelledBookings,
        firstBooking: bookings[bookings.length - 1]?.startTime,
        lastBooking: bookings[0]?.startTime,
      },
      bookedBy: Array.from(bookedByMap.values()),
    };
  }

  /**
   * Get booking statistics for a specific date
   */
  async getDateStatistics(date: Date, organizationId: string) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const bookings = await Appointment.find({
      organizationId,
      'customerBooking.isCustomerBooking': true,
      startTime: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    }).populate('createdBy', 'name email');

    const byStatus = {
      scheduled: bookings.filter(b => b.status === 'scheduled').length,
      confirmed: bookings.filter(b => b.status === 'confirmed').length,
      cancelled: bookings.filter(b => b.status === 'cancelled').length,
      completed: bookings.filter(b => b.status === 'completed').length
    };

    const byOrganizer: { [key: string]: number } = {};
    bookings.forEach(booking => {
      const organizerName = (booking.createdBy as any).name || 'Unknown';
      byOrganizer[organizerName] = (byOrganizer[organizerName] || 0) + 1;
    });

    return {
      date: date.toISOString(),
      totalBookings: bookings.length,
      byStatus,
      byOrganizer,
      bookings: bookings.map(b => ({
        _id: b._id,
        title: b.title,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        customerName: b.customerBooking
          ? `${b.customerBooking.firstName} ${b.customerBooking.lastName}`
          : 'Unknown',
        organizerName: (b.createdBy as any).name,
      }))
    };
  }

  /**
   * Update customer booking history after appointment completion
   */
  async updateBookingHistory(appointmentId: string) {
    const appointment = await Appointment.findById(appointmentId);

    if (!appointment || !appointment.customerBooking) {
      return;
    }

    const { email, phone, firstName, lastName } = appointment.customerBooking;

    // Find all bookings for this customer
    const allBookings = await Appointment.find({
      'customerBooking.isCustomerBooking': true,
      $or: [
        { 'customerBooking.email': email },
        {
          $expr: {
            $and: [
              { $eq: [{ $toLower: '$customerBooking.firstName' }, firstName.toLowerCase()] },
              { $eq: [{ $toLower: '$customerBooking.lastName' }, lastName.toLowerCase()] }
            ]
          }
        }
      ]
    }).select('_id');

    const bookingIds = allBookings.map(b => b._id);

    // Update all bookings with the full history
    await Appointment.updateMany(
      { _id: { $in: bookingIds } },
      {
        $set: {
          'customerBooking.bookingHistory.previousBookings': bookingIds,
          'customerBooking.bookingHistory.totalBookings': bookingIds.length,
          'customerBooking.bookingHistory.lastBookedAt': new Date()
        }
      }
    );
  }
}

export default new CustomerBookingService();
