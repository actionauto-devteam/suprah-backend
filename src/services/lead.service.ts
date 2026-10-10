import mongoose from 'mongoose';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import FinanceApplication, { IFinanceApplication } from '../models/FinanceApplication.model';
import Vehicle from '../models/Vehicle.model';
import Organization from '../models/Organization.model';
import Lead from '../models/lead.model';
import IntakeClaim from '../models/IntakeClaim.model';
import notificationService from './notification.service';
import { generateADF, ADFLeadData } from '../utils/adfGenerator';
import { resolveOrgSystemUserId } from '../utils/orgSystemUser';
import { LEAD_SOURCE } from '../constants/leadSource';
import { emitToOrg } from '../utils/socketEmitter';
import { triggerAiReplyForNewInquiry } from './communication.service';
import logger from '../utils/logger';
import { ApiError } from '../utils/ApiError';

const VEHICLE_INQUIRY_DEDUP_WINDOW_MS = 15 * 60 * 1000;

export interface InquiryDTO {
  organizationId: string;
  customerId: string;
  vehicleId: string;
  comments?: string;
  customerName: { first: string; last: string };
  customerEmail: string;
  customerPhone: string;
}

export interface FinanceAppDTO {
  organizationId: string;
  customerId: string;
  vehicleId: string;
  personalInfo: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dob: string;
    ssn: string;
    address: {
      street: string;
      city: string;
      state: string;
      zip: string;
    };
  };
  employmentInfo: {
    employer: string;
    jobTitle: string;
    income: string;
    incomeFrequency: 'Yearly' | 'Monthly' | 'Weekly';
    yearsAtJob: string;
  };
}

class LeadService {
  async processInquiry(dto: InquiryDTO): Promise<void> {
    const { organizationId, vehicleId, customerId } = dto;

    const config = await OrgLeadConfig.findOne({ organizationId, isActive: true });
    if (!config || !config.gmailConnected) {
      throw new ApiError(400, 'This dealership has not configured their lead ingestion system.');
    }

    const [vehicle, org] = await Promise.all([
      Vehicle.findById(vehicleId),
      Organization.findById(organizationId)
    ]);

    if (!vehicle) {
      throw new ApiError(404, 'Vehicle not found');
    }
    if (!org) {
      throw new ApiError(404, 'Organization not found');
    }

    const claimKey = `${customerId}:${vehicleId}`;
    const claimResult = await IntakeClaim.findOneAndUpdate(
      { organizationId, kind: 'vehicle_inquiry', claimKey },
      {
        $setOnInsert: {
          organizationId,
          kind: 'vehicle_inquiry',
          claimKey,
          expiresAt: new Date(Date.now() + VEHICLE_INQUIRY_DEDUP_WINDOW_MS),
        },
      },
      { new: true, upsert: true, includeResultMetadata: true },
    );

    if (claimResult.lastErrorObject?.updatedExisting) {
      logger.info(
        { organizationId, customerId, vehicleId },
        'Duplicate on-site vehicle inquiry ignored (already processed within the dedup window)',
      );
      return;
    }

    const adfData: ADFLeadData = {
      prospect: {
        customer: {
          contact: {
            name: [
              { part: 'first', value: dto.customerName.first },
              { part: 'last', value: dto.customerName.last },
            ],
            email: dto.customerEmail,
            phone: dto.customerPhone,
          },
          comments: dto.comments,
        },
        vehicle: {
          interest: 'buy',
          status: vehicle.isNewVehicle ? 'new' : 'used',
          year: vehicle.year.toString(),
          make: vehicle.make,
          model: vehicle.modelName,
          vin: vehicle.vin,
          stock: vehicle.stockNumber,
          trim: vehicle.trim,
          price: vehicle.price?.toString(),
        },
        vendor: {
          name: org.name || 'Your Dealership',
          contact: {
            name: org.name,
            email: config.gmailAddress,
            // NOTE: street/city/regioncode/postalcode below are still the
            // original single-tenant client's business address, hardcoded
            // for every org's ADF lead. Organization has no address field
            // today, so making this per-tenant needs a schema addition —
            // flagged rather than guessed at here.
            address: {
              street: '170 West State Road',
              city: 'Lehi',
              regioncode: 'UT',
              postalcode: '84043'
            }
          }
        },
        provider: {
          name: 'Suprah.AI Digital Retail',
          service: 'Website Inquiry',
          url: 'https://www.suprah.ai'
        },
      },
    };

    const adfXml = generateADF(adfData);

    try {
      const systemUserId = await resolveOrgSystemUserId(organizationId);
      if (!systemUserId) {
        throw new ApiError(400, 'This dealership is not yet set up to receive online inquiries');
      }

      const lead = await Lead.create({
        organizationId,
        createdBy: systemUserId,
        firstName: dto.customerName.first,
        lastName: dto.customerName.last,
        email: dto.customerEmail,
        phone: dto.customerPhone,
        vehicle: {
          year: vehicle.year?.toString(),
          make: vehicle.make,
          model: vehicle.modelName,
          vin: vehicle.vin,
          stock: vehicle.stockNumber,
          trim: vehicle.trim,
          price: vehicle.price?.toString(),
        },
        vehicleId: vehicle._id,
        location: vehicle.dealerCity || undefined,
        comments: dto.comments,
        parsedContent: adfXml,
        channel: 'web',
        source: LEAD_SOURCE.WEBSITE_INQUIRY,
        status: 'New',
      });

      await IntakeClaim.updateOne(
        { organizationId, kind: 'vehicle_inquiry', claimKey },
        { $set: { leadId: lead._id } },
      );

      triggerAiReplyForNewInquiry(organizationId, lead, lead.phone, lead.comments).catch((err) => {
        logger.error({ err, organizationId, leadId: lead._id }, '[LeadService] triggerAiReplyForNewInquiry failed');
      });

      emitToOrg(String(organizationId), 'lead:new', lead.toObject());

      logger.info(
        { organizationId, customerId: dto.customerId, vehicleId, leadId: lead._id },
        'Vehicle inquiry processed and Lead created directly (no bounce email)'
      );
    } catch (error) {
      await IntakeClaim.deleteOne({ organizationId, kind: 'vehicle_inquiry', claimKey }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Process a Finance Application
   * 1. Uses a MongoDB Transaction for ACID atomicity
   * 2. Saves encrypted record to FinanceApplication model
   * 3. Triggers internal staff notification
   */
  async processFinanceApp(dto: FinanceAppDTO): Promise<IFinanceApplication> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Get Vehicle for context
      const vehicle = await Vehicle.findById(dto.vehicleId).session(session);
      if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
      }

      // 2. Create the Application (Encryption handled in Model pre-save hook)
      const app = new FinanceApplication({
        organizationId: dto.organizationId,
        customerId: dto.customerId,
        vehicleId: dto.vehicleId,
        personalInfo: dto.personalInfo,
        employmentInfo: dto.employmentInfo,
        status: 'New',
        appliedAt: new Date(),
      });

      await app.save({ session });

      // 3. Broadcast Internal Notification to Staff (Dealer/Admin/Employee)
      await notificationService.broadcastNotification({
        organizationId: dto.organizationId,
        roleTargets: ['dealer', 'admin', 'super_admin'],
        type: 'new_lead', // Using existing lead type for high visibility
        title: 'New Finance Application',
        message: `${dto.personalInfo.firstName} ${dto.personalInfo.lastName} submitted a credit application for ${vehicle.year} ${vehicle.make} ${vehicle.model}.`,
        metadata: {
          financeAppId: app._id,
          vehicleId: vehicle._id,
          customerId: dto.customerId,
        },
      });

      // 4. Commit Transaction
      await session.commitTransaction();
      
      logger.info(
        { organizationId: dto.organizationId, appId: app._id },
        'Finance application saved and notification broadcasted'
      );

      return app;
    } catch (error) {
      // Rollback on any failure
      await session.abortTransaction();
      logger.error({ error, dto }, 'Finance application transaction failed and rolled back');
      throw error;
    } finally {
      session.endSession();
    }
  }
}

export default new LeadService();
