import { Request, Response } from 'express';
import crypto from 'crypto';
import Invitation from '../models/Invitation.model';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import emailService from '../services/email.service';
import config from '../config';

export const createInvitation = async (req: Request, res: Response) => {
    const { email, role } = req.body;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
        throw new ApiError(400, 'You must belong to an organization to invite members');
    }

    // specific check: only admin can invite
    if (req.user?.organizationRole !== 'admin') {
        throw new ApiError(403, 'Only admins can invite members');
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
            role: role || 'member',
            token,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            status: 'pending',
        });
    }

    const org = await Organization.findById(organizationId);
    const inviteLink = `${config.corsOrigin}/accept-invite?token=${token}`;

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

    const invite = await Invitation.findOne({ token, status: 'pending' }).populate('organizationId', 'name slug logoUrl');

    if (!invite) {
        throw new ApiError(404, 'Invitation not found or invalid');
    }

    if (invite.expiresAt < new Date()) {
        invite.status = 'expired';
        await invite.save();
        throw new ApiError(400, 'Invitation has expired');
    }

    res.status(200).json({
        success: true,
        data: invite,
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
    user.organizationRole = invite.role;
    await user.save();

    // Update invite
    invite.status = 'accepted';
    await invite.save();

    res.status(200).json({
        success: true,
        message: 'Invitation accepted',
        data: {
            organizationId: invite.organizationId,
            role: invite.role
        }
    });
};
