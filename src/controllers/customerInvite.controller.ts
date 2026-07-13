import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CustomerInviteToken from '../models/CustomerInviteToken.model';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import emailService from '../services/email.service';
import config from '../config';

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const BULK_TEMP_PASSWORD = 'customersaccount';
const MAX_BULK = 50;

function generateShortCode(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function nameFromEmail(email: string): string {
  const prefix = email.split('@')[0];
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export const generateInviteLinks = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser!;
  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can generate customer invite links');
  }

  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), MAX_BULK);
  const multiUse = req.body.multiUse === true || req.body.multiUse === 'true';
  const org = await Organization.findById(actor.organizationId).lean();
  if (!org) throw new ApiError(404, 'Organization not found');

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invites = [];

  for (let i = 0; i < count; i++) {
    let shortCode = generateShortCode();
    let attempts = 0;
    while (await CustomerInviteToken.exists({ shortCode }) && attempts < 5) {
      shortCode = generateShortCode();
      attempts++;
    }

    await CustomerInviteToken.create({
      shortCode,
      organizationId: actor.organizationId,
      createdBy: actor._id,
      expiresAt,
      multiUse,
    });

    invites.push({
      shortCode,
      link: `${config.frontendUrl}/join/${shortCode}`,
      expiresAt,
      multiUse,
    });
  }

  res.json(new ApiResponse(201, { invites }, 'Invite link(s) generated'));
});

/**
 * POST /api/crm/customer-invites/bulk-create
 * CRM admin only — create accounts for a list of existing customers.
 * Body: { emails: string[] }
 */
export const bulkCreateCustomerAccounts = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser!;
  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can bulk-create customer accounts');
  }

  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length === 0) {
    throw new ApiError(400, 'emails must be a non-empty array');
  }
  if (emails.length > MAX_BULK) {
    throw new ApiError(400, `Cannot create more than ${MAX_BULK} accounts at once`);
  }

  const org = await Organization.findById(actor.organizationId).lean();
  if (!org) throw new ApiError(404, 'Organization not found');

  const passwordHash = await bcrypt.hash(BULK_TEMP_PASSWORD, 10);

  const results: { email: string; status: 'created' | 'already_exists' | 'error'; reason?: string }[] = [];

  for (const rawEmail of emails) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.push({ email, status: 'error', reason: 'Invalid email format' });
      continue;
    }

    const existing = await User.findOne({ email });
    if (existing) {
      results.push({ email, status: 'already_exists', reason: 'Account already exists' });
      continue;
    }

    try {
      const name = nameFromEmail(email);
      await User.create({
        name,
        email,
        password: passwordHash,
        role: 'customer',
        organizationId: actor.organizationId,
        emailVerified: true,
        isApproved: true,
        onboardingCompleted: true,
      });

      // Send credentials email
      await emailService.sendEmail({
        to: email,
        subject: `Your ${org.name} customer account is ready`,
        text: `Hello ${name},\n\nYour customer account at ${org.name} has been created.\n\nEmail: ${email}\nTemporary password: ${BULK_TEMP_PASSWORD}\n\nPlease log in and update your password at your earliest convenience.\n\n${config.frontendUrl}/sign-in`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#111">Your account at ${org.name} is ready</h2>
            <p>Hello <strong>${name}</strong>,</p>
            <p>An account has been created for you on the ${org.name} platform.</p>
            <table style="border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:4px 12px 4px 0;color:#555">Email</td><td style="padding:4px 0"><strong>${email}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#555">Temporary password</td><td style="padding:4px 0"><strong>${BULK_TEMP_PASSWORD}</strong></td></tr>
            </table>
            <p>Please log in and change your password.</p>
            <a href="${config.frontendUrl}/sign-in" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px">Log in now</a>
          </div>
        `,
        organizationId: actor.organizationId?.toString(),
      });

      results.push({ email, status: 'created' });
    } catch (err: any) {
      results.push({ email, status: 'error', reason: err.message || 'Unknown error' });
    }
  }

  const created = results.filter(r => r.status === 'created').length;
  const skipped = results.filter(r => r.status === 'already_exists').length;
  const failed  = results.filter(r => r.status === 'error').length;

  res.json(new ApiResponse(200, { results, created, skipped, failed },
    `Done: ${created} created, ${skipped} skipped (already exist), ${failed} failed`));
});

/**
 * GET /api/auth/invite/:shortCode
 * Public — validate a customer invite link and return org info.
 */
export const validateInviteLink = asyncHandler(async (req: Request, res: Response) => {
  const { shortCode } = req.params;

  const token = await CustomerInviteToken.findOne({ shortCode }).lean();

  if (!token) {
    return res.json(new ApiResponse(200, { valid: false, reason: 'not_found' }, 'Invalid link'));
  }
  if (!token.multiUse && token.isUsed) {
    return res.json(new ApiResponse(200, { valid: false, reason: 'used' }, 'Link already used'));
  }
  if (new Date() > token.expiresAt) {
    return res.json(new ApiResponse(200, { valid: false, reason: 'expired' }, 'Link has expired'));
  }

  const org = await Organization.findById(token.organizationId).select('name logoUrl').lean();
  if (!org) {
    return res.json(new ApiResponse(200, { valid: false, reason: 'not_found' }, 'Organization not found'));
  }

  res.json(new ApiResponse(200, {
    valid: true,
    orgName: org.name,
    orgLogo: org.logoUrl ?? null,
    expiresAt: token.expiresAt,
  }, 'Invite link is valid'));
});

/**
 * POST /api/auth/invite/:shortCode/register
 * Public — register a customer account via an invite link.
 * Body: { name, email, password }
 */
export const registerViaInvite = asyncHandler(async (req: Request, res: Response) => {
  const { shortCode } = req.params;
  const { name, email, password } = req.body;

  if (!name?.trim() || !email?.trim() || !password) {
    throw new ApiError(400, 'name, email, and password are required');
  }
  if (password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters');
  }

  const token = await CustomerInviteToken.findOne({ shortCode });
  if (!token) throw new ApiError(404, 'Invite link not found');
  if (!token.multiUse && token.isUsed) throw new ApiError(410, 'This invite link has already been used');
  if (new Date() > token.expiresAt) throw new ApiError(410, 'This invite link has expired');

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) throw new ApiError(400, 'An account with this email already exists');

  const org = await Organization.findById(token.organizationId).select('name logoUrl').lean();
  if (!org) throw new ApiError(404, 'Organization not found');

  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
    role: 'customer',
    organizationId: token.organizationId,
    emailVerified: true,
    isApproved: true,
    onboardingCompleted: true,
  });

  // For single-use tokens, mark as used; multi-use tokens stay active until expiry
  if (!token.multiUse) {
    token.isUsed = true;
    token.usedAt = new Date();
    token.usedBy = user._id as any;
    await token.save();
  }

  // Send confirmation email
  try {
    await emailService.sendEmail({
      to: normalizedEmail,
      subject: `Welcome to ${org.name} - account created`,
      text: `Hello ${name.trim()},\n\nYour customer account at ${org.name} has been successfully created.\n\nEmail: ${normalizedEmail}\nPassword: ${password}\n\nYou can now log in at: ${config.frontendUrl}/sign-in`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#111">Welcome to ${org.name}!</h2>
          <p>Hello <strong>${name.trim()}</strong>,</p>
          <p>Your customer account has been successfully created.</p>
          <table style="border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:4px 12px 4px 0;color:#555">Email</td><td style="padding:4px 0"><strong>${normalizedEmail}</strong></td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#555">Password</td><td style="padding:4px 0"><strong>${password}</strong></td></tr>
          </table>
          <a href="${config.frontendUrl}/sign-in" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px">Log in now</a>
        </div>
      `,
      organizationId: token.organizationId.toString(),
    });
  } catch {
    // Email failure is non-fatal — account is already created
  }

  res.status(201).json(new ApiResponse(201, { email: normalizedEmail }, 'Account created successfully'));
});

/**
 * GET /api/crm/customer-invites/customers
 * CRM admin only — list all customer accounts for the org.
 * Query: { search?, sortBy?, sortOrder?, page?, limit? }
 */
export const getCustomers = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser!;
  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can view the customer list');
  }
  if (!actor.organizationId) {
    throw new ApiError(403, 'Account not linked to an organization');
  }

  const {
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    page = '1',
    limit = '50',
  } = req.query;

  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {
    role: 'customer',
    organizationId: actor.organizationId,
  };

  const searchValue = typeof search === 'string' ? search.trim() : '';
  if (searchValue) {
    const escaped = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
    ];
  }

  const sortFieldMap: Record<string, string> = {
    name: 'name',
    email: 'email',
    createdAt: 'createdAt',
    joined: 'createdAt',
  };
  const resolvedSortBy =
    typeof sortBy === 'string' && sortFieldMap[sortBy] ? sortFieldMap[sortBy] : 'createdAt';
  const resolvedSortOrder = sortOrder === 'asc' ? 1 : -1;

  const [customers, total] = await Promise.all([
    User.find(filter)
      .select('name email avatar role isActive createdAt')
      .sort({ [resolvedSortBy]: resolvedSortOrder })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    User.countDocuments(filter),
  ]);

  res.json(
    new ApiResponse(200, {
      customers,
      total,
      pagination: { page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    }, 'Customers fetched'),
  );
});

export const deleteCustomer = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser!;
  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can delete customer accounts');
  }
  if (!actor.organizationId) {
    throw new ApiError(403, 'Account not linked to an organization');
  }

  const { userId } = req.params;

  const customer = await User.findOne({
    _id: userId,
    role: 'customer',
    organizationId: actor.organizationId,
  });

  if (!customer) {
    throw new ApiError(404, 'Customer account not found');
  }

  await User.deleteOne({ _id: customer._id });

  res.json(new ApiResponse(200, { deletedId: userId }, 'Customer account deleted'));
});
