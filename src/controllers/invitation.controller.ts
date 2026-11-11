import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import crypto from 'crypto';
import Invitation from '../models/Invitation.model';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import emailService from '../services/email.service';
import config from '../config';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { safeCreateNotification, notifyOrgAdmins, safeBroadcastNotification } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { invalidateUserCache } from '../utils/cache.util';
import {
    INVITATION_MESSAGES,
    INVITE_INPUT_MESSAGES,
    adminInviteNote,
    invitationAcceptanceProblem,
    invitedAccountStatus,
    inviteEmailOrNull,
    staffInviteRoleOrNull,
    staffInviteTargetProblem,
} from '../utils/invitationAcceptance';
import { staffInviteEmail } from '../utils/staffInviteEmail';

export const createInvitation = asyncHandler(async (req: Request, res: Response) => {
    const { email: rawEmail, role } = req.body;
    const organizationId = req.orgId;

    if (!organizationId) {
        throw new ApiError(400, 'You must belong to an organization to invite members');
    }

    const isAdmin = req.orgRole === 'admin' || req.user?.role === 'admin' || req.user?.role === 'super_admin';
    if (!isAdmin) {
        throw new ApiError(403, 'Only admins can invite members');
    }

    if (role === 'driver') {
        throw new ApiError(400, 'Drivers cannot be invited through team invitations. Driver approval goes through the platform driver-request queue.');
    }

    // Only a real email address and the Member or Admin role (2026-11-11).
    const inviteRole = staffInviteRoleOrNull(role);
    if (!inviteRole) {
        throw new ApiError(400, INVITE_INPUT_MESSAGES.role);
    }
    const email = inviteEmailOrNull(rawEmail);
    if (!email) {
        throw new ApiError(400, INVITE_INPUT_MESSAGES.email);
    }

    if (!req.user) {
        throw new ApiError(401, 'User context missing');
    }

    // A driver account can't be staff, and a customer of this dealership can
    // become staff; only someone already on the team is turned away (2026-11-11).
    const existingUser = await User.findOne({ email: String(email ?? '').trim().toLowerCase() }).select('role organizationId').lean();
    const targetProblem = staffInviteTargetProblem({ existing: existingUser, organizationId });
    if (targetProblem) {
        throw new ApiError(targetProblem.status, targetProblem.message);
    }

    const existingInvite = await Invitation.findOne({
        email,
        organizationId,
        status: 'pending',
    });

    let token = '';
    if (existingInvite) {
        token = existingInvite.token;
        existingInvite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await existingInvite.save();
    } else {
        token = crypto.randomBytes(32).toString('hex');
        await Invitation.create({
            email,
            organizationId,
            inviterId: req.user._id,
            role: inviteRole,
            token,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            status: 'pending',
        });

        await activityService.createActivity({
            userId: req.user._id.toString(),
            organizationId: organizationId.toString(),
            type: 'other',
            title: 'Team Invitation Sent',
            description: `Sent invitation to ${email} as ${inviteRole}`,
            metadata: { email, role: inviteRole }
        });

        logger.info({ inviterId: req.user._id, organizationId }, 'Team invitation sent');

        // Notify the inviter that invitation was sent
        const org = await Organization.findById(organizationId);
        const { title, message } = notificationTemplates.team_invite_sent({
            email,
            organizationName: org?.name || 'your organization',
        });

        await safeCreateNotification({
            userId: req.user._id.toString(),
            organizationId: organizationId?.toString() || 'global',
            type: 'team_invite_sent',
            title,
            message,
            metadata: {
                invitedEmail: email,
                role: inviteRole,
                organizationName: org?.name,
            },
        });
    }

    const org = await Organization.findById(organizationId);
    const inviteLink = `${config.frontendUrl}/accept-invite?token=${token}`;

    let emailSent = true;
    try {
        // Names are escaped, and the link only goes to the invited email,
        // never to the logs (2026-11-11).
        await emailService.sendEmail({
            to: email,
            ...staffInviteEmail({ inviterName: req.user?.name, organizationName: org?.name, inviteLink }),
        });
    } catch (error) {
        logger.warn({ err: error }, 'Failed to send a staff invitation email');
        // The invitation is saved either way. The admin is told the email
        // didn't go out, and inviting again resends the same invitation.
        emailSent = false;
    }

    res.status(201).json({
        success: true,
        message: 'Invitation sent',
        data: {
            // The invitation link only goes to the invited email, not back to
            // the admin, and the admin only hears when the email is one of the
            // dealership's own customers (2026-11-11).
            existingAccount: adminInviteNote(existingUser, organizationId),
            emailSent,
        }
    });
});

export const validateInvitation = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params;

    // 1. Find by token only (ignore status for now)
    const invite = await Invitation.findOne({ token })
        .populate('organizationId', 'name slug logoUrl')
        .populate('inviterId', 'name email avatar');

    if (!invite) {
        throw new ApiError(404, INVITATION_MESSAGES.notFound);
    }

    // 2. Check Expiration
    if (invite.expiresAt < new Date()) {
        if (invite.status !== 'expired') {
            invite.status = 'expired';
            await invite.save();
        }
        throw new ApiError(400, INVITATION_MESSAGES.expired);
    }

    // What kind of account the invited email already has, so the page can say
    // what accepting will do before anyone presses a button (2026-11-11).
    const invitedAccount = await User.findOne({ email: String(invite.email).trim().toLowerCase() }).select('role organizationId').lean();
    const accountStatus = invitedAccountStatus(invitedAccount, (invite.organizationId as any)?._id ?? invite.organizationId);

    // 3. Check Status
    if (invite.status === 'accepted') {
        // Return a successful validation even if accepted, but flag it
        // This allows the frontend to show "You are already a member" or redirect
        return res.status(200).json({
            success: true,
            data: {
                organizationName: (invite.organizationId as any).name,
                inviterName: (invite.inviterId as any)?.name || 'Someone',
                email: invite.email,
                role: invite.role,
                _id: invite._id,
                token: invite.token,
                isAlreadyAccepted: true,
                accountStatus,
            },
        });
    }

    if (invite.status !== 'pending') {
        throw new ApiError(400, invite.status === 'expired' ? INVITATION_MESSAGES.expired : INVITATION_MESSAGES.cancelled);
    }

    // Format response for frontend
    const responseData = {
        organizationName: (invite.organizationId as any).name,
        inviterName: (invite.inviterId as any)?.name || 'Someone',
        email: invite.email,
        role: invite.role,
        _id: invite._id,
        token: invite.token,
        accountStatus,
    };

    res.status(200).json({
        success: true,
        data: responseData,
    });
});

export const acceptInvitation = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body;
    const user = req.user;

    if (!user) {
        throw new ApiError(401, 'You must be logged in to accept an invitation');
    }

    let invite = await Invitation.findOne({ token, status: 'pending' });

    if (!invite) {
        // Check if it's already accepted by this user
        const acceptedInvite = await Invitation.findOne({ token, status: 'accepted' });
        if (acceptedInvite && acceptedInvite.organizationId?.toString() === user.organizationId?.toString()) {
            return res.status(200).json({
                success: true,
                message: 'You are already a member of this organization',
                data: {
                    organizationId: acceptedInvite.organizationId,
                    role: acceptedInvite.role
                }
            });
        }
        throw new ApiError(404, INVITATION_MESSAGES.used);
    }

    if (invite.expiresAt < new Date()) {
        invite.status = 'expired';
        await invite.save();
        throw new ApiError(400, INVITATION_MESSAGES.expired);
    }

    // Driver invitations through this path are no longer supported (a stray
    // pre-existing pending invite could still carry role: 'driver' even
    // though creation is now blocked) — reject explicitly rather than
    // silently falling through and leaving the user un-promoted.
    if ((invite.role as string) === 'driver') {
        throw new ApiError(410, 'Driver invitations are no longer supported. Please use the driver application form instead.');
    }

    // Only the account the invitation was sent to may accept it, and never a
    // driver account (2026-11-11). Before, a different email was allowed and
    // only logged, so any signed-in account holding the link could join.
    const problem = invitationAcceptanceProblem({ inviteEmail: invite.email, userEmail: user.email, userRole: user.role });
    if (problem) throw new ApiError(problem.status, problem.message);

    // Update user
    user.organizationId = invite.organizationId as any;

    // Boost organization role if the user is a global platform admin
    const finalRole = (user.role === 'admin') ? 'admin' : invite.role;
    (user as any).organizationRole = finalRole;

    // Promote customer to their invited role
    if (user.role === 'customer') {
        if (invite.role === 'admin' || invite.role === 'member') {
            user.role = 'employee';
        }
    }

    user.onboardingCompleted = true;
    await user.save();
    // The new organization and role apply to the user's very next request.
    invalidateUserCache(user._id.toString());

    // Update invite
    invite.status = 'accepted';
    await invite.save();

    // Notify all admins in the organization that a new member joined
    const org = await Organization.findById(invite.organizationId);
    const { title, message } = notificationTemplates.team_member_joined({
        memberName: user.name || user.email,
        organizationName: org?.name || 'the organization',
        role: invite.role,
    });

    await notifyOrgAdmins(
        invite.organizationId?.toString() || '',
        'team_member_joined',
        title,
        message,
        {
            newMemberId: user._id.toString(),
            memberName: user.name || user.email,
            memberEmail: user.email,
            role: invite.role,
        },
        user._id.toString() // Exclude the user who just joined
    );

    // Also notify the original inviter specifically
    if (invite.inviterId) {
        await safeCreateNotification({
            userId: invite.inviterId.toString(),
            organizationId: invite.organizationId?.toString() || 'global',
            type: 'team_member_joined',
            title: 'Invitation Accepted',
            message: `${user.name || user.email} accepted your invitation to join ${org?.name || 'the organization'}`,
            metadata: {
                newMemberId: user._id.toString(),
                memberName: user.name || user.email,
                memberEmail: user.email,
                role: invite.role,
            },
        });
    }

    await activityService.createActivity({
        userId: user._id.toString(),
        organizationId: invite.organizationId?.toString(),
        type: 'other',
        title: 'Invitation Accepted',
        description: `Joined organization via invitation`,
        metadata: { organizationId: invite.organizationId, role: invite.role }
    });

    logger.info({ userId: user._id, orgId: invite.organizationId }, 'Invitation accepted');

    res.status(200).json({
        success: true,
        message: 'Invitation accepted',
        data: {
            organizationId: invite.organizationId,
            role: invite.role
        }
    });
});

export const bulkCreateInvitations = asyncHandler(async (req: Request, res: Response) => {
    const { emails, role } = req.body;
    const organizationId = req.orgId;

    if (!organizationId) {
        throw new ApiError(400, 'You must belong to an organization to invite members');
    }

    const isAdmin = req.orgRole === 'admin' || req.user?.role === 'admin' || req.user?.role === 'super_admin';
    if (!isAdmin) {
        throw new ApiError(403, 'Only admins can invite members');
    }

    if (role === 'driver') {
        throw new ApiError(400, 'Drivers cannot be invited through team invitations. Driver approval goes through the platform driver-request queue.');
    }

    // Only the Member or Admin role (2026-11-11).
    const inviteRole = staffInviteRoleOrNull(role);
    if (!inviteRole) {
        throw new ApiError(400, INVITE_INPUT_MESSAGES.role);
    }

    if (!emails || !Array.isArray(emails)) {
        throw new ApiError(400, 'An array of emails is required');
    }

    if (emails.length > 50) {
        throw new ApiError(400, 'Maximum of 50 invitations allowed per request');
    }

    const org = await Organization.findById(organizationId);
    if (!org) {
        throw new ApiError(404, 'Organization not found');
    }

    const results = {
        sent: [] as string[],
        failed: [] as string[],
        alreadyMember: [] as string[],
        // Emails of driver accounts, which can't be staff (2026-11-11).
        driverAccounts: [] as string[],
    };

    const inviterName = req.user?.name || 'Someone';

    for (const rawEmail of emails) {
        const email = inviteEmailOrNull(rawEmail);
        try {
            if (!email) {
                results.failed.push(String(rawEmail ?? ''));
                continue;
            }

            const existingUser = await User.findOne({ email: String(email).trim().toLowerCase() }).select('role organizationId').lean();
            const targetProblem = staffInviteTargetProblem({ existing: existingUser, organizationId });
            if (targetProblem) {
                (targetProblem.kind === 'driver' ? results.driverAccounts : results.alreadyMember).push(email);
                continue;
            }

            const existingInvite = await Invitation.findOne({ email, organizationId, status: 'pending' });
            let token = existingInvite?.token || crypto.randomBytes(32).toString('hex');

            if (existingInvite) {
                existingInvite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                await existingInvite.save();
            } else {
                await Invitation.create({
                    email,
                    organizationId,
                    inviterId: req.user?._id,
                    role: inviteRole,
                    token,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    status: 'pending',
                });
            }

            const inviteLink = `${config.frontendUrl}/accept-invite?token=${token}`;

            await emailService.sendEmail({
                to: email,
                ...staffInviteEmail({ inviterName, organizationName: org.name, inviteLink }),
            });

            results.sent.push(email);
        } catch (error) {
            // No email address in the logs (2026-11-11).
            logger.warn({ err: error }, 'Failed to send a bulk staff invitation');
            results.failed.push(email ?? String(rawEmail ?? ''));
        }
    }

    await activityService.createActivity({
        userId: (req.user?._id as any).toString(),
        organizationId: organizationId.toString(),
        type: 'other',
        title: 'Bulk Invitations Sent',
        description: `Attempted to invite ${emails.length} users`,
        metadata: { sentCount: results.sent.length, failedCount: results.failed.length }
    });

    logger.info({ inviterId: req.user?._id, count: results.sent.length }, 'Bulk invitations processed');

    res.status(200).json({
        success: true,
        message: 'Bulk invitations processed',
        data: results
    });
});
