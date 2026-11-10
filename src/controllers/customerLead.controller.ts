import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import leadService from '../services/lead.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import User from '../models/User.model';
import { financeApplicationExtras, financeApplicationOwner } from '../utils/financeApplicationDetails';

class CustomerLeadController {
  submitInquiry = asyncHandler(async (req: Request, res: Response) => {
    const { comments, firstName, lastName, email, phone } = req.body;
    const user = req.user!;
    const { organizationId, vehicle } = req.leadContext!;

    await leadService.processInquiry({
      organizationId,
      customerId: user._id.toString(),
      vehicleId: vehicle._id.toString(),
      comments,
      customerName: {
        first: firstName || user.name?.split(' ')[0] || 'Guest',
        last: lastName || user.name?.split(' ').slice(1).join(' ') || '',
      },
      customerEmail: email || user.email,
      customerPhone: phone || user.personalInfo?.phone || '',
    });

    return res.status(200).json(
      new ApiResponse(200, null, 'Inquiry sent successfully. The dealership will contact you soon.')
    );
  });

  submitFinanceApp = asyncHandler(async (req: Request, res: Response) => {
    const { personalInfo, employmentInfo } = req.body;
    const user = req.user!;
    const { organizationId, vehicle } = req.leadContext!;
    const extras = financeApplicationExtras(req.body);

    // A customer's own application is theirs; when staff fill it in, it's
    // recorded under the customer with that email (2026-11-10).
    const owner = await financeApplicationOwner(user as any, personalInfo?.email, async (email) => {
      const customer = await User.findOne({ email, role: 'customer' }).select('_id').lean<{ _id: unknown } | null>();
      return customer ? String(customer._id) : null;
    });

    const app = await leadService.processFinanceApp({
      organizationId,
      customerId: owner.customerId,
      submittedBy: owner.submittedBy,
      vehicleId: vehicle._id.toString(),
      personalInfo: {
        ...personalInfo,
        applicationType: extras.applicationType,
        maritalStatus: extras.maritalStatus,
        driversLicenseNumber: extras.driversLicenseNumber,
      },
      employmentInfo: {
        ...employmentInfo,
        workPhone: extras.workPhone,
        payFrequency: extras.payFrequency,
      },
      residence: extras.residence,
      reference: extras.reference,
      tradeIn: extras.tradeIn,
    });

    logger.info({ appId: app._id, customerId: owner.customerId, submittedBy: owner.submittedBy }, 'Finance application submitted successfully');

    return res.status(201).json(
      new ApiResponse(201, { appId: app._id }, 'Finance application submitted successfully.')
    );
  });
}

export default new CustomerLeadController();
