import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import leadService from '../services/lead.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';

/**
 * Controller for handling customer-facing lead submissions
 */
class CustomerLeadController {
  /**
   * Handle Vehicle Inquiry Submission
   * POST /api/leads/customer/inquiry
   */
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

  /**
   * Handle Finance Application Submission
   * POST /api/leads/customer/finance
   */
  submitFinanceApp = asyncHandler(async (req: Request, res: Response) => {
    const { personalInfo, employmentInfo } = req.body;
    const user = req.user!;
    const { organizationId, vehicle } = req.leadContext!;

    const app = await leadService.processFinanceApp({
      organizationId,
      customerId: user._id.toString(),
      vehicleId: vehicle._id.toString(),
      personalInfo,
      employmentInfo,
    });

    logger.info({ appId: app._id, customerId: user._id }, 'Finance application submitted successfully');

    return res.status(201).json(
      new ApiResponse(201, { appId: app._id }, 'Finance application submitted successfully.')
    );
  });
}

export default new CustomerLeadController();
