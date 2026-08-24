import crypto from 'crypto';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DealershipInquiry from '../models/DealershipInquiry.model';
import CustomerInviteToken from '../models/CustomerInviteToken.model';
import User, { IUser } from '../models/User.model';
import notificationService from '../services/notification.service';
import emailService from '../services/email.service';
import config from '../config';

const SETUP_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateShortCode(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

/**
 * POST /api/dealership-inquiries
 * Public — a prospective dealership leaves their email for superadmin to
 * follow up with. Does not create any account.
 */
export const submitDealershipInquiry = asyncHandler(async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    throw new ApiError(400, 'A valid email address is required');
  }

  let inquiry = await DealershipInquiry.findOne({ email, status: 'pending' });
  if (!inquiry) {
    inquiry = await DealershipInquiry.create({ email, status: 'pending' });
  }

  const admins = await User.find({ role: 'super_admin' });
  for (const admin of admins) {
    await notificationService.createNotification({
      userId: admin._id.toString(),
      organizationId: admin.organizationId?.toString() || 'global',
      type: 'dealership_inquiry',
      title: 'New Dealership Inquiry',
      message: `${email} is interested in registering a dealership.`,
      metadata: {
        dealershipInquiryId: inquiry._id.toString(),
        email,
      },
    }).catch((err) => console.error('[DealershipInquiry] Notification failed:', err));
  }

  res.status(201).json(new ApiResponse(201, { email }, 'Thanks — our team will review your request and follow up by email.'));
});

/**
 * GET /api/admin/dealership-inquiries
 * Superadmin only — list inquiries, optionally filtered by status.
 */
export const listDealershipInquiries = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;

  const filter: any = {};
  if (status && status !== 'all') {
    filter.status = status;
  }

  const [inquiries, total] = await Promise.all([
    DealershipInquiry.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('invitedBy', 'name email')
      .populate('registeredOrganizationId', 'name slug')
      .lean(),
    DealershipInquiry.countDocuments(filter),
  ]);

  res.json(new ApiResponse(200, {
    inquiries,
    total,
    pagination: { page, limit, totalPages: Math.ceil(total / limit) },
  }, 'Dealership inquiries fetched'));
});

/**
 * GET /api/admin/dealership-inquiries/:id
 * Superadmin only — single inquiry detail.
 */
export const getDealershipInquiry = asyncHandler(async (req: Request, res: Response) => {
  const inquiry = await DealershipInquiry.findById(req.params.id)
    .populate('invitedBy', 'name email')
    .populate('registeredOrganizationId', 'name slug')
    .lean();
  if (!inquiry) throw new ApiError(404, 'Inquiry not found');

  res.json(new ApiResponse(200, inquiry, 'Dealership inquiry fetched'));
});

/**
 * POST /api/admin/dealership-inquiries/:id/send-link
 * Superadmin only — generate a private, single-use, email-bound setup link
 * and email it to the inquirer.
 */
export const sendDealershipSetupLink = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.user as IUser;
  const inquiry = await DealershipInquiry.findById(req.params.id);
  if (!inquiry) throw new ApiError(404, 'Inquiry not found');
  if (inquiry.status === 'registered') {
    throw new ApiError(400, 'This dealership has already completed registration');
  }

  let shortCode = generateShortCode();
  let attempts = 0;
  while ((await CustomerInviteToken.exists({ shortCode })) && attempts < 5) {
    shortCode = generateShortCode();
    attempts++;
  }

  const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_MS);
  const token = await CustomerInviteToken.create({
    shortCode,
    email: inquiry.email,
    accountType: 'dealership',
    multiUse: false,
    createdByUser: actor._id,
    expiresAt,
  });

  inquiry.status = 'invited';
  inquiry.invitedAt = new Date();
  inquiry.invitedBy = actor._id as any;
  inquiry.inviteTokenId = token._id as any;
  await inquiry.save();

  const link = `${config.frontendUrl}/dealership-setup/${shortCode}`;

  try {
    await emailService.sendEmail({
      to: inquiry.email,
      subject: 'Set up your dealership on Suprah.AI',
      text: `You're invited to set up your dealership on Suprah.AI. This link is private to you and can only be used once: ${link}\n\nIt expires in 7 days.`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#111">Set up your dealership on Suprah.AI</h2>
          <p>You're invited to register your dealership. This link is private to <strong>${inquiry.email}</strong> and can only be used once.</p>
          <a href="${link}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px">Set up my dealership</a>
          <p style="margin-top:20px;font-size:12px;color:#666">This link expires in 7 days and cannot be reused once you've registered.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('[DealershipInquiry] Failed to send setup link email:', err);
  }

  res.json(new ApiResponse(200, { email: inquiry.email, expiresAt }, 'Setup link sent'));
});

/**
 * POST /api/admin/dealership-inquiries/:id/dismiss
 * Superadmin only — mark an inquiry as not being pursued.
 */
export const dismissDealershipInquiry = asyncHandler(async (req: Request, res: Response) => {
  const inquiry = await DealershipInquiry.findById(req.params.id);
  if (!inquiry) throw new ApiError(404, 'Inquiry not found');
  if (inquiry.status === 'registered') {
    throw new ApiError(400, 'This dealership has already completed registration');
  }

  inquiry.status = 'dismissed';
  await inquiry.save();

  res.json(new ApiResponse(200, inquiry, 'Inquiry dismissed'));
});
