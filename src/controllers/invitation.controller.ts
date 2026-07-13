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

export const createInvitation = asyncHandler(async (req: Request, res: Response) => {
    const { email, role } = req.body;
    const organizationId = req.orgId;

    if (!organizationId) {
        throw new ApiError(400, 'You must belong to an organization to invite members');
    }

    const isAdmin = req.orgRole === 'admin' || req.user?.role === 'admin' || req.user?.role === 'super_admin';
    if (!isAdmin) {
        throw new ApiError(403, 'Only admins can invite members');
    }

    if (!req.user) {
        throw new ApiError(401, 'User context missing');
    }

    const existingUser = await User.findOne({ email, organizationId });
    if (existingUser) {
        throw new ApiError(400, 'User is already a member of this organization');
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
            role: role || 'member',
            token,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            status: 'pending',
        });

        await activityService.createActivity({
            userId: req.user._id.toString(),
            organizationId: organizationId.toString(),
            type: 'other',
            title: 'Team Invitation Sent',
            description: `Sent invitation to ${email} as ${role || 'member'}`,
            metadata: { email, role }
        });

        logger.info({ inviterId: req.user._id, invitedEmail: email }, 'Team invitation sent');

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
                role: role || 'member',
                organizationName: org?.name,
            },
        });
    }

    const org = await Organization.findById(organizationId);
    const inviteLink = `${config.frontendUrl}/accept-invite?token=${token}`;

    console.log(inviteLink);

    try {
        await emailService.sendEmail({
            to: email,
            subject: `You've been invited to join ${org?.name} on Action Auto`,
            text: `You have been invited to join the organization ${org?.name}. Click here to accept: ${inviteLink}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>You've been invited!</h2>
                    <p><strong>${req.user?.name}</strong> has invited you to join the organization <strong>${org?.name}</strong>.</p>
                    <p>Click the button below to accept the invitation:</p>
                    <a href="${inviteLink}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
                    <p style="margin-top: 20px; font-size: 12px; color: #666;">If you did not expect this invitation, you can ignore this email.</p>
                </div>
            `
        });
    } catch (error) {
        console.error('Failed to send invitation email:', error);
        // We ensure the invite is created even if email fails, so they can manually share the link if needed
        // But in production we might want to throw error or return a warning
    }

    res.status(201).json({
        success: true,
        message: 'Invitation sent',
        data: { token } // Return token for debug/manual sharing
    });
});

export const validateInvitation = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params;

    console.log('[InvitationController] Validating token:', token);

    // 1. Find by token only (ignore status for now)
    const invite = await Invitation.findOne({ token })
        .populate('organizationId', 'name slug logoUrl')
        .populate('inviterId', 'name email avatar');

    if (!invite) {
        console.log('[InvitationController] Token not found in DB');
        throw new ApiError(404, 'Invitation not found');
    }

    console.log('[InvitationController] Invite found. Status:', invite.status);

    // 2. Check Expiration
    if (invite.expiresAt < new Date()) {
        if (invite.status !== 'expired') {
            invite.status = 'expired';
            await invite.save();
        }
        throw new ApiError(400, 'Invitation has expired');
    }

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
                isAlreadyAccepted: true
            },
        });
    }

    if (invite.status !== 'pending') {
        throw new ApiError(400, `Invitation is ${invite.status}`);
    }

    // Format response for frontend
    const responseData = {
        organizationName: (invite.organizationId as any).name,
        inviterName: (invite.inviterId as any)?.name || 'Someone',
        email: invite.email,
        role: invite.role,
        _id: invite._id,
        token: invite.token
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
        throw new ApiError(404, 'Invitation not found or already used');
    }

    if (invite.expiresAt < new Date()) {
        invite.status = 'expired';
        await invite.save();
        throw new ApiError(400, 'Invitation has expired');
    }

    // Verify email matches (optional security measure, but good practice)
    // If the logged in user's email doesn't match the invite string, strictly speaking we should block or warn.
    // But often people invite personal emails and accept on work emails. 
    // For now, we will allow it but maybe log it.
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        console.warn(`Warning: User ${user.email} accepted invite for ${invite.email}`);
    }

    // Update user
    user.organizationId = invite.organizationId as any;

    // Boost organization role if the user is a global platform admin
    const finalRole = (user.role === 'admin') ? 'admin' : invite.role;
    (user as any).organizationRole = finalRole;

    // Promote customer to their invited role
    if (user.role === 'customer') {
        if (invite.role === 'admin' || invite.role === 'member') {
            user.role = 'employee';
        } else if (invite.role === 'driver') {
            user.role = 'driver';
            user.isApproved = true; // Invited drivers are trusted by the dealership that invited them
        }
    }

    user.onboardingCompleted = true;
    await user.save();

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
    };

    const inviterName = req.user?.name || 'Someone';

    for (const email of emails) {
        try {
            if (!email || !email.includes('@')) {
                results.failed.push(email);
                continue;
            }

            const existingUser = await User.findOne({ email, organizationId });
            if (existingUser) {
                results.alreadyMember.push(email);
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
                    role: role || 'member',
                    token,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    status: 'pending',
                });
            }

            const inviteLink = `${config.frontendUrl}/accept-invite?token=${token}`;

            await emailService.sendEmail({
                to: email,
                subject: `You've been invited to join ${org.name} on Action Auto`,
                text: `You have been invited to join the organization ${org.name}. Accept here: ${inviteLink}`,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px;">
                        <h2>You've been invited!</h2>
                        <p><strong>${inviterName}</strong> has invited you to join the organization <strong>${org.name}</strong>.</p>
                        <p>Click the button below to accept the invitation:</p>
                        <a href="${inviteLink}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
                    </div>
                `
            });

            results.sent.push(email);
        } catch (error) {
            console.error(`Failed to process invitation for ${email}:`, error);
            results.failed.push(email);
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
