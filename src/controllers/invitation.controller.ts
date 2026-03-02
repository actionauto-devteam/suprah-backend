import { Request, Response } from 'express';
import crypto from 'crypto';
import Invitation from '../models/Invitation.model';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import emailService from '../services/email.service';
import AuditLog from '../models/AuditLog.model';
import config from '../config';
import { safeCreateNotification, notifyOrgAdmins, safeBroadcastNotification } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';

export const createInvitation = async (req: Request, res: Response) => {
    const { email, role } = req.body;
    const organizationId = req.orgId;

    if (!organizationId) {
        throw new ApiError(400, 'You must belong to an organization to invite members');
    }

    // specific check: only admin can invite
    if (req.orgRole !== 'admin') {
        throw new ApiError(403, 'Only admins can invite members');
    }

    if (!req.user) {
        throw new ApiError(401, 'User context missing');
    }

    // Check if user is already a member
    const existingUser = await User.findOne({ email, organizationId });
    if (existingUser) {
        throw new ApiError(400, 'User is already a member of this organization');
    }

    // Check if invitation already exists
    const existingInvite = await Invitation.findOne({
        email,
        organizationId,
        status: 'pending',
    });

    let token = '';
    if (existingInvite) {
        // Resend existing invite
        token = existingInvite.token;
        // Extend expiration
        existingInvite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await existingInvite.save();
    } else {
        // Create new invite
        token = crypto.randomBytes(32).toString('hex');
        await Invitation.create({
            email,
            organizationId,
            inviterId: req.user._id, // Save inviter
            role: role || 'member',
            token,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            status: 'pending',
        });

        await AuditLog.create({
            entityType: 'Invitation',
            entityId: token, // We don't have ID easily unless we grab form create, but token is unique enough or we use email
            action: 'CREATE',
            reason: `Invitation sent to ${email}`,
            performedBy: req.user._id,
            changes: { email, organizationId, role }
        });

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
};

export const validateInvitation = async (req: Request, res: Response) => {
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
        throw new ApiError(400, 'Invitation has already been accepted');
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
};

export const acceptInvitation = async (req: Request, res: Response) => {
    const { token } = req.body;
    const userId = req.auth?.userId;
    const user = req.user;

    if (!userId || !user) {
        throw new ApiError(401, 'You must be logged in to accept an invitation');
    }

    const invite = await Invitation.findOne({ token, status: 'pending' });

    if (!invite) {
        throw new ApiError(404, 'Invitation not found or invalid');
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
    user.organizationId = invite.organizationId as any; // Cast because logic implies it is an ObjectId
    (user as any).organizationRole = invite.role;

    // Promote customer to employee upon joining an organization
    if (user.role === 'customer') {
        user.role = 'employee';
    }

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

    await AuditLog.create({
        entityType: 'Invitation',
        entityId: invite._id,
        action: 'UPDATE',
        reason: `Invitation accepted by ${user.email}`,
        performedBy: user._id,
        changes: { status: 'accepted' }
    });

    await AuditLog.create({
        entityType: 'User',
        entityId: user._id,
        action: 'UPDATE',
        reason: `User joined organization ${invite.organizationId}`,
        performedBy: user._id,
        changes: { organizationId: invite.organizationId, role: invite.role }
    });

    res.status(200).json({
        success: true,
        message: 'Invitation accepted',
        data: {
            organizationId: invite.organizationId,
            role: invite.role
        }
    });
};
