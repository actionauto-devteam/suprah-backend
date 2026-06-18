import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import ReferralLead from '../models/ReferralLead.model';
import User from '../models/User.model';
import Referral from '../models/referral.model';
import membershipService from '../services/membership.service';
import { emitToOrg } from '../utils/socketEmitter';
import config from '../config';
import emailService from '../services/email.service';

// ─── JaaS JWT helper ──────────────────────────────────────────────────────────
const JAAS_APP_ID      = process.env.JAAS_APP_ID      || '';
const JAAS_KID         = process.env.JAAS_KID         || '';
const JAAS_PRIVATE_KEY = (process.env.JAAS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function referralJitsiToken(opts: {
  id:    string;
  name:  string;
  email?: string;
  room:  string;
}) {
  const payload = {
    context: {
      user: {
        id:    opts.id,
        name:  opts.name,
        ...(opts.email ? { email: opts.email } : {}),
      },
      features: {
        livestreaming:   false,
        recording:       false,
        transcription:   false,
        'outbound-call': false,
      },
    },
    aud:  'jitsi',
    iss:  'chat',
    sub:  JAAS_APP_ID,
    room: '*',
    exp:  Math.floor(Date.now() / 1000) + 60 * 60 * 4,
    nbf:  Math.floor(Date.now() / 1000) - 10,
  };
  return jwt.sign(payload, JAAS_PRIVATE_KEY, {
    algorithm: 'RS256',
    header:    { alg: 'RS256', kid: JAAS_KID, typ: 'JWT' } as any,
  });
}

// ─── PUBLIC: Validate code & return referrer first name ───────────────────────
// GET /api/referral-leads/info/:code
export const getPublicReferralInfo = asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.params;
  if (!code) throw new ApiError(400, 'Referral code is required');

  const referrer = await User.findOne({ referralCode: code.toUpperCase() })
    .select('name referralCode organizationId')
    .lean();

  if (!referrer) {
    return res.json(new ApiResponse(200, { valid: false }, 'Invalid referral code'));
  }

  res.json(
    new ApiResponse(200, {
      valid: true,
      referrerName:      referrer.name || '',
      referrerFirstName: (referrer.name || '').split(' ')[0] || referrer.name,
      referralCode:      referrer.referralCode,
    }, 'Referral info fetched'),
  );
});

// ─── PUBLIC: Submit call request ──────────────────────────────────────────────
// POST /api/referral-leads/request
export const submitReferralRequest = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone, email, requestType, referralCode } = req.body;

  if (!name || !phone || !email || !requestType || !referralCode) {
    throw new ApiError(400, 'name, phone, email, requestType, and referralCode are required');
  }
  if (!['voice', 'video'].includes(requestType)) {
    throw new ApiError(400, 'requestType must be voice or video');
  }

  const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() })
    .select('_id organizationId')
    .lean();

  if (!referrer) throw new ApiError(404, 'Invalid referral code');
  if (!referrer.organizationId) throw new ApiError(400, 'Referrer is not linked to a dealership');

  // Block if this email already belongs to a customer account in this org
  const existingAccount = await User.findOne({
    email:          email.trim().toLowerCase(),
    organizationId: referrer.organizationId,
    role:           'customer',
  }).select('_id').lean();

  if (existingAccount) {
    throw new ApiError(409, 'An account with this email already exists at this dealership. Please log in or contact our team for assistance.');
  }

  // Duplicate check — block if phone OR email already has an active lead in this org
  const [dupPhone, dupEmail] = await Promise.all([
    ReferralLead.findOne({
      phone:          phone.trim(),
      organizationId: referrer.organizationId,
      status:         { $in: ['pending', 'contacted'] },
    }).select('_id').lean(),
    ReferralLead.findOne({
      email:          email.trim().toLowerCase(),
      organizationId: referrer.organizationId,
      status:         { $in: ['pending', 'contacted'] },
    }).select('_id').lean(),
  ]);

  if (dupPhone || dupEmail) {
    throw new ApiError(409, 'You already have a pending inquiry with this dealership. Our team will be in touch soon — no need to submit again.');
  }

  const lead = await ReferralLead.create({
    name:           name.trim(),
    phone:          phone.trim(),
    email:          email.trim().toLowerCase(),
    requestType,
    referralCode:   referralCode.toUpperCase(),
    referrerId:     referrer._id,
    organizationId: referrer.organizationId,
    status:         'pending',
  });

  // Emit real-time event so the CRM referrals page updates without a refresh
  try {
    const referrerInfo = await User.findById(referrer._id)
      .select('name email referralCode')
      .lean();

    emitToOrg(referrer.organizationId.toString(), 'referral:new_lead', {
      _id:          lead._id,
      name:         lead.name,
      phone:        lead.phone,
      requestType:  lead.requestType,
      referralCode: lead.referralCode,
      status:       lead.status,
      createdAt:    lead.createdAt,
      referrerId:   referrerInfo ?? { _id: referrer._id },
    });
  } catch {
    // Non-fatal — REST response still goes through
  }

  res.status(201).json(new ApiResponse(201, { _id: lead._id }, 'Call request submitted'));
});

// ─── CRM: List all referral leads for this org ────────────────────────────────
// GET /api/referral-leads/crm-leads
export const getReferralLeads = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Not linked to an organization');

  const { status } = req.query;
  const filter: Record<string, unknown> = { organizationId: orgId };
  if (status && ['pending', 'contacted', 'converted', 'closed'].includes(status as string)) {
    filter.status = status;
  }

  const leads = await ReferralLead.find(filter)
    .populate('referrerId', 'name email referralCode avatarUrl')
    .populate('convertedUserId', 'name email')
    .sort({ createdAt: -1 })
    .lean();

  res.json(new ApiResponse(200, leads, 'Referral leads fetched'));
});

// ─── CRM: Update lead status / notes ─────────────────────────────────────────
// PATCH /api/referral-leads/crm-leads/:id/status
export const updateLeadStatus = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Not linked to an organization');

  const { id } = req.params;
  const { status, notes } = req.body;

  const valid = ['pending', 'contacted', 'converted', 'closed'];
  if (!valid.includes(status)) throw new ApiError(400, `status must be one of: ${valid.join(', ')}`);

  const updates: Record<string, unknown> = { status };
  if (notes !== undefined) updates.notes = notes;

  const lead = await ReferralLead.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    updates,
    { new: true },
  );
  if (!lead) throw new ApiError(404, 'Lead not found');

  res.json(new ApiResponse(200, lead, 'Lead updated'));
});

// ─── CRM: Convert lead → create customer account ─────────────────────────────
// POST /api/referral-leads/crm-leads/:id/convert
// Body: { email }
// Password is always set to 'customer123' and emailed directly to the customer.
export const convertLead = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Not linked to an organization');

  const { id } = req.params;
  const { email } = req.body;
  if (!email) throw new ApiError(400, 'email is required');

  const lead = await ReferralLead.findOne({ _id: id, organizationId: orgId });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.status === 'converted') throw new ApiError(400, 'This lead has already been converted');

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) throw new ApiError(409, 'A user with this email already exists');

  const tempPassword = 'customer123';
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const newUser = await User.create({
    name:           lead.name,
    email:          email.toLowerCase().trim(),
    passwordHash,
    role:           'customer',
    organizationId: orgId,
    emailVerified:  true,
    isActive:       true,
    isApproved:     true,
    personalInfo:   { phone: lead.phone },
  });

  // Create Referral record so the $100 reward fires when a payment is made
  await Referral.create({
    organizationId:   orgId,
    referrerId:       lead.referrerId,
    referredUserId:   newUser._id,
    referralCodeUsed: lead.referralCode,
  });

  lead.status          = 'converted';
  lead.convertedUserId = newUser._id as any;
  await lead.save();

  // Send welcome email with credentials directly to the customer (fire and forget)
  emailService.sendEmail({
    to:      newUser.email,
    subject: 'Your Action Auto Customer Account is Ready',
    text: `Hi ${newUser.name},\n\nOne of our representatives has created a customer account for you at Action Auto Utah.\n\nYour Login Credentials:\nEmail: ${newUser.email}\nTemporary Password: ${tempPassword}\n\nPlease log in and change your password as soon as possible to keep your account secure.\n\nAction Auto Utah`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#10b981;padding:32px 40px;text-align:center;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.75);">Action Auto Utah</p>
            <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;">Your Account is Ready!</h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 8px;font-size:15px;color:#18181b;font-weight:600;">Hi ${newUser.name},</p>
            <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.6;">
              One of our representatives has created a <strong style="color:#18181b;">customer account</strong> for you at Action Auto Utah. Use the credentials below to sign in.
            </p>

            <!-- Credentials box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;border-radius:12px;margin-bottom:20px;">
              <tr>
                <td style="padding:20px 24px;">
                  <p style="margin:0 0 12px;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#a1a1aa;">Your Login Credentials</p>
                  <p style="margin:0 0 4px;font-size:12px;color:#71717a;font-weight:500;">Email</p>
                  <p style="margin:0 0 16px;font-size:14px;font-weight:700;color:#18181b;">${newUser.email}</p>
                  <p style="margin:0 0 4px;font-size:12px;color:#71717a;font-weight:500;">Temporary Password</p>
                  <p style="margin:0;font-size:22px;font-weight:800;color:#10b981;font-family:'Courier New',monospace;letter-spacing:0.05em;">${tempPassword}</p>
                </td>
              </tr>
            </table>

            <!-- Warning box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;margin-bottom:24px;">
              <tr>
                <td style="padding:14px 18px;">
                  <p style="margin:0;font-size:12px;color:#92400e;line-height:1.5;">
                    &#9888;&#65039; <strong>Please change your password after your first login</strong> to keep your account secure.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f4f4f5;padding:20px 40px;text-align:center;border-top:1px solid #e4e4e7;">
            <p style="margin:0;font-size:11px;color:#a1a1aa;">© ${new Date().getFullYear()} Action Auto Utah &middot; Powered by Suprah AI</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
    .then(() => console.log(`[ConvertLead] Welcome email sent to ${newUser.email}`))
    .catch((err: any) => console.error('[ConvertLead] Welcome email send failed:', err));

  // Credit the referrer's membership points for the conversion (fire and forget)
  if (lead.referrerId) {
    const referrer = await User.findById(lead.referrerId).select('_id organizationId').lean();
    if (referrer) {
      membershipService.creditPoints({
        userId: referrer._id.toString(),
        organizationId: referrer.organizationId?.toString() || orgId || 'global',
        delta: 300,
        sourceType: 'referral_conversion',
        sourceId: lead._id!.toString(),
        description: `Referral conversion: ${lead.name || lead.email} joined`,
        metadata: { referralLeadId: lead._id!.toString() },
      }).catch(() => null);
    }
  }

  res.status(201).json(
    new ApiResponse(201, {
      userId: newUser._id,
      name:   newUser.name,
      email:  newUser.email,
    }, 'Customer account created successfully'),
  );
});

// ─── CRM: Start a call room for a referral lead ───────────────────────────────
// POST /api/referral-leads/crm-leads/:id/start-call
export const startLeadCall = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Not linked to an organization');

  const { id } = req.params;
  const lead = await ReferralLead.findOne({ _id: id, organizationId: orgId });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const crmUser = (req as any).crmUser;
  const repName = crmUser?.fullName || crmUser?.username || 'Representative';
  const repId   = crmUser?._id?.toString() || 'crm-rep';

  const room      = `referral-${lead._id.toString()}`;
  const jitsiRoom = `${JAAS_APP_ID}/${room}`;

  const staffToken = referralJitsiToken({ id: repId, name: repName, email: crmUser?.username, room });

  const domain = process.env.JITSI_DOMAIN || '8x8.vc';
  const publicJoinUrl = `${config.frontendUrl}/support/call/${encodeURIComponent(room)}`;

  // Send email invitation — fire and forget (non-blocking), use org Gmail API if connected
  if (lead.email) {
    const callTypeLabel = lead.requestType === 'voice' ? 'Voice Call' : 'Video Call';
    const accentColor   = lead.requestType === 'voice' ? '#10b981' : '#3b82f6';

    console.log(`[ReferralCall] Sending invitation email to ${lead.email} for lead ${lead._id}`);
    emailService.sendEmail({
      to:      lead.email,
      subject: `${repName} is inviting you to a ${callTypeLabel} — Action Auto`,
      text:           `Hi ${lead.name},\n\nYour Action Auto representative, ${repName}, has started a ${callTypeLabel} and is ready to speak with you.\n\nJoin the call here:\n${publicJoinUrl}\n\nOpen the link, enter your email address (${lead.email}), and you'll be connected instantly.\n\nAction Auto Utah`,
      html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:${accentColor};padding:32px 40px;text-align:center;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.75);">Action Auto Utah</p>
            <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;">${callTypeLabel} Invitation</h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 8px;font-size:15px;color:#18181b;font-weight:600;">Hi ${lead.name},</p>
            <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.6;">
              <strong style="color:#18181b;">${repName}</strong>, your Action Auto representative, has started a
              <strong style="color:${accentColor};">${callTypeLabel}</strong> and is ready to speak with you right now.
            </p>

            <!-- CTA Button -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px 0 28px;">
                  <a href="${publicJoinUrl}"
                     style="display:inline-block;background:${accentColor};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;letter-spacing:0.01em;">
                    Join ${callTypeLabel} Now →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;">When prompted, enter your email address to verify:</p>
            <p style="margin:0 0 24px;font-size:12px;font-weight:700;color:#18181b;background:#f4f4f5;padding:10px 14px;border-radius:8px;">${lead.email}</p>

            <p style="margin:0 0 8px;font-size:12px;color:#a1a1aa;">Or copy the link into your browser:</p>
            <p style="margin:0 0 24px;font-size:11px;color:#6366f1;word-break:break-all;background:#f4f4f5;padding:10px 14px;border-radius:8px;font-family:monospace;">${publicJoinUrl}</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f4f4f5;padding:20px 40px;text-align:center;border-top:1px solid #e4e4e7;">
            <p style="margin:0;font-size:11px;color:#a1a1aa;">© ${new Date().getFullYear()} Action Auto Utah · Powered by Suprah AI</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
    })
      .then(() => console.log(`[ReferralCall] Invitation email sent to ${lead.email}`))
      .catch((err: any) => console.error('[ReferralCall] Email send failed:', err));
  }

  res.json(new ApiResponse(200, {
    domain,
    room,
    jitsiRoom,
    jwt:             staffToken,
    publicJoinUrl,
    callType:        lead.requestType,
    leadName:        lead.name,
    leadPhone:       lead.phone,
    leadEmail:       lead.email || null,
    emailSent:  !!lead.email,
  }, 'Call room ready'));
});

// ─── PUBLIC: Guest join token for a referral call room ────────────────────────
// GET /api/referral-leads/call/:room/guest-token?email=...
export const getGuestCallToken = asyncHandler(async (req: Request, res: Response) => {
  const { room } = req.params;
  const email = (req.query.email as string || '').trim().toLowerCase();

  if (!email) throw new ApiError(400, 'email query param is required');
  if (!room.startsWith('referral-')) throw new ApiError(403, 'Invalid call room');

  // Extract lead ID from room name ("referral-<id>") and verify email
  const leadId = room.replace('referral-', '');
  const lead = await ReferralLead.findById(leadId).select('name email').lean();

  if (!lead) throw new ApiError(404, 'Call room not found');
  if (!lead.email || lead.email.toLowerCase() !== email) {
    throw new ApiError(403, 'Email does not match our records for this call');
  }

  const guestToken = referralJitsiToken({
    id:    `guest-${Date.now()}`,
    name:  lead.name.slice(0, 50),
    email: lead.email,
    room,
  });

  const domain    = process.env.JITSI_DOMAIN || '8x8.vc';
  const jitsiRoom = `${JAAS_APP_ID}/${room}`;

  res.json(new ApiResponse(200, { domain, room, jitsiRoom, jwt: guestToken, displayName: lead.name }, 'Guest token issued'));
});

