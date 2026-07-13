import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import User, { IUser } from '../models/User.model';
import Referral from '../models/referral.model';
import Transaction from '../models/transaction.model';
import ReferralService from '../services/referral.service';
import activityService from '../services/activity.service';
import linkedAccountService from '../services/linkedAccount.service';
import logger from '../utils/logger';


const getWalletDashboard = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id;
    const user = (req.user as IUser);

    if (!userId) {
        return res.status(401).json(new ApiResponse(401, null, 'User ID not found'));
    }

    let linkedStatus: any = { connected: false, primary: null, accounts: [] };
    try {
        linkedStatus = await linkedAccountService.getStatus(userId.toString());
        if (linkedStatus.connected) {
            await linkedAccountService.syncBalances(userId.toString());
        }
    } catch (e) {
        logger.warn({ userId, err: (e as Error).message }, 'Wallet live-sync skipped');
    }

    const userProfile = await User.findById(userId)
        .select('walletBalance totalEarned referralCode')
        .lean();
    if (!userProfile) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    const pendingLeadsCount = await Referral.countDocuments({ referrerId: userId });

    const transactions = await Transaction.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

    res.json(new ApiResponse(200, {
        walletBalance: userProfile.walletBalance,
        totalEarned: userProfile.totalEarned,
        referralCode: userProfile.referralCode,
        pendingLeads: pendingLeadsCount,
        recentTransactions: transactions,
        linkedAccount: linkedStatus,
    }, 'Wallet dashboard fetched successfully'));
});

const linkReferral = asyncHandler(async (req: Request, res: Response) => {
    const { referralCode } = req.body;
    const newUser = (req.user as IUser);
    const newUserId = newUser._id;

    if (!referralCode || !newUserId) {
        return res.status(400).json(new ApiResponse(400, null, 'Referral code and User ID required'));
    }

    const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });
    if (!referrer) {
        return res.status(404).json(new ApiResponse(404, null, 'Invalid referral code'));
    }
    if (referrer._id.toString() === newUserId.toString()) {
        return res.status(400).json(new ApiResponse(400, null, 'You cannot refer yourself'));
    }

    const existingReferral = await Referral.findOne({ referredUserId: newUserId });
    if (existingReferral) {
        return res.status(400).json(new ApiResponse(400, null, 'You have already been referred'));
    }

    const newReferral = await Referral.create({
        referrerId: referrer._id,
        referredUserId: newUserId,
        referralCodeUsed: referrer.referralCode
    });

    try {
        await ReferralService.notifyReferralSignup(newReferral._id.toString());
    } catch (error) {
        console.error('[Referral] Error sending signup notification:', error);
    }

    await activityService.createActivity({
        userId: newUserId.toString(),
        organizationId: newUser.organizationId?.toString(),
        type: 'referral_applied',
        title: 'Referral Applied',
        description: `Applied referral code: ${referralCode}`,
        metadata: { referrerId: referrer._id.toString(), referralCode }
    });

    logger.info({ userId: newUserId, referrerId: referrer._id, referralCode }, 'Referral linked successfully');
    res.status(201).json(new ApiResponse(201, newReferral, 'Referral linked successfully'));
});

// 3. Request a Withdrawal  (FIX: Transaction.organizationId is REQUIRED)
const requestWithdrawal = asyncHandler(async (req: Request, res: Response) => {
    const { amount, methodType, methodDetails } = req.body;
    const user = (req.user as IUser);
    const userId = user._id;

    if (!amount || amount <= 0 || !methodType || !methodDetails) {
        return res.status(400).json(new ApiResponse(400, null, 'Amount, withdrawal method, and details are required'));
    }

    const dbUser = await User.findById(userId);
    if (!dbUser) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    const organizationId = dbUser.organizationId || req.orgId;
    if (!organizationId) {
        return res.status(400).json(new ApiResponse(400, null, 'No organization context for this withdrawal'));
    }

    const pendingWithdrawals = await Transaction.aggregate([
        { $match: { userId: userId, type: 'withdrawal', status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalPending = pendingWithdrawals.length > 0 ? pendingWithdrawals[0].total : 0;
    const netAvailable = (dbUser.walletBalance ?? 0) - totalPending;

    if (netAvailable < amount) {
        return res.status(400).json(new ApiResponse(400, null,
            `Insufficient available balance. You have $${totalPending.toFixed(2)} in pending withdrawals.`));
    }

    const withdrawal = await Transaction.create({
        organizationId,            // ← required field, was missing before
        userId,
        type: 'withdrawal',
        status: 'pending',
        amount,
        note: `Withdrawal request to ${methodType}`,
        withdrawalMethod: { type: methodType, details: methodDetails }
    });

    await activityService.logFinancialActivity(
        userId.toString(),
        organizationId.toString(),
        'withdrawal_requested',
        amount,
        `Requested withdrawal of $${amount.toFixed(2)} via ${methodType}`,
        { transactionId: withdrawal._id.toString(), methodType }
    );

    logger.info({ userId, amount, methodType }, 'Withdrawal request submitted');
    res.status(201).json(new ApiResponse(201, withdrawal, 'Withdrawal request submitted for Admin review'));
});

export default {
    getWalletDashboard,
    linkReferral,
    requestWithdrawal
};