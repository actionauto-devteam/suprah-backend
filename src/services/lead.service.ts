import mongoose from 'mongoose';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import FinanceApplication, { IFinanceApplication } from '../models/FinanceApplication.model';
import Vehicle from '../models/Vehicle.model';
import Organization from '../models/Organization.model';
import orgGmailService from './orgGmail.service';
import notificationService from './notification.service';
import { generateADF, ADFLeadData } from '../utils/adfGenerator';
import logger from '../utils/logger';
import { ApiError } from '../utils/ApiError';

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
  /**
   * Process a Vehicle Inquiry (Lead)
   * 1. Fetches Org Lead Config
   * 2. Generates ADF XML
   * 3. Sends email via OrgGmailService (Automatic Token Refresh handled there)
   * 4. Returns success (Existing sync jobs will create the Lead record later)
   */
  async processInquiry(dto: InquiryDTO): Promise<void> {
    const { organizationId, vehicleId } = dto;

    // 1. Get Org Config
    const config = await OrgLeadConfig.findOne({ organizationId, isActive: true });
    if (!config || !config.gmailConnected) {
      throw new ApiError(400, 'This dealership has not configured their lead ingestion system.');
    }

    // 2. Get Vehicle & Org Details
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

    // 3. Prepare ADF Data
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
          name: org.name || 'Action Auto Sales and Finance LLC',
          contact: {
            name: org.name,
            email: config.gmailAddress,
            address: {
              street: '170 West State Road',
              city: 'Lehi',
              regioncode: 'UT',
              postalcode: '84043'
            }
          }
        },
        provider: {
          name: 'ActionAuto Digital Retail',
          service: 'Website Inquiry',
          url: 'https://www.actionautoutah.com'
        },
      },
    };

    // 4. Generate XML
    const adfXml = generateADF(adfData);

    // 5. Build Industry Standard Subject Line
    // Format: vehicle lead for Action Auto Sales and Finance LLC-2023 HYUNDAI IONIQ 5 (www.actionautoutah.com)
    const vehicleFull = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;
    const subject = `vehicle lead for ${org.name}-${vehicleFull} (www.actionautoutah.com)`;

    // 6. Send Email (The "Bounce" Flow)
    await orgGmailService.sendEmail(
      organizationId,
      config.leadSourceEmail,
      subject,
      adfXml
    );

    logger.info(
      { organizationId, customerId: dto.customerId, vehicleId, destination: config.leadSourceEmail },
      'Vehicle inquiry processed and ADF email dispatched'
    );
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
