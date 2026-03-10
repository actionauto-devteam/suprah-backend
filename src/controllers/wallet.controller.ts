import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import User, { IUser } from '../models/User.model';
import Referral from '../models/referral.model';
import Transaction from '../models/transaction.model';
import ReferralService from '../services/referral.service';

// 1. Get Wallet Dashboard Data
const getWalletDashboard = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id;
    const user = (req.user as IUser);

    if (!userId) {
        return res.status(401).json(new ApiResponse(401, null, 'User ID not found'));
    }

    // A. User Wallet Data - User is already in req.user, but we might want fresh data
    const userProfile = await User.findById(userId).select('walletBalance totalEarned referralCode').lean();
    if (!userProfile) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    // B. Pending Leads Count (How many people have they referred)
    // Query by referrerId (ObjectId) first, fallback to clerkId for legacy
    const pendingLeadsCount = await Referral.countDocuments({
        referrerId: userId
    });

    // C. Recent Transaction Ledger
    const transactions = await Transaction.find({
        userId: userId
    })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

    res.json(new ApiResponse(200, {
        walletBalance: userProfile.walletBalance,
        totalEarned: userProfile.totalEarned,
        referralCode: userProfile.referralCode,
        pendingLeads: pendingLeadsCount,
        recentTransactions: transactions
    }, 'Wallet dashboard fetched successfully'));
});

// 2. Link a New Referral
const linkReferral = asyncHandler(async (req: Request, res: Response) => {
    const { referralCode } = req.body;
    const newUser = (req.user as IUser);
    const newUserId = newUser._id;

    if (!referralCode || !newUserId) {
        return res.status(400).json(new ApiResponse(400, null, 'Referral code and User ID required'));
    }

    // Validate the referral code belongs to a real user
    const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });

    if (!referrer) {
        return res.status(404).json(new ApiResponse(404, null, 'Invalid referral code'));
    }

    if (referrer._id.toString() === newUserId.toString()) {
        return res.status(400).json(new ApiResponse(400, null, 'You cannot refer yourself'));
    }

    // Check if this user was already referred
    const existingReferral = await Referral.findOne({
        referredUserId: newUserId
    });
    if (existingReferral) {
        return res.status(400).json(new ApiResponse(400, null, 'You have already been referred'));
    }

    // Create the Referral link
    const newReferral = await Referral.create({
        referrerId: referrer._id,
        referredUserId: newUserId,
        referralCodeUsed: referrer.referralCode
    });

    // Notify Referrer about the new signup
    try {
        await ReferralService.notifyReferralSignup(newReferral._id.toString());
    } catch (error) {
        console.error('[Referral] Error sending signup notification:', error);
    }

    console.log(`[Referral Engine] SUCCESS: User ${newUserId} (Native) joined via ${referrer.name}'s link (${referralCode})!`);

    res.status(201).json(new ApiResponse(201, newReferral, 'Referral linked successfully'));
});

// 3. Request a Withdrawal
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

    // Calculate "Net Available Balance" (Total Balance - Pending Withdrawals)
    const pendingWithdrawals = await Transaction.aggregate([
        {
            $match: {
                userId: userId,
                type: 'withdrawal',
                status: 'pending'
            }
        },
        { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const totalPending = pendingWithdrawals.length > 0 ? pendingWithdrawals[0].total : 0;
    const netAvailable = user.walletBalance - totalPending;

    if (netAvailable < amount) {
        return res.status(400).json(new ApiResponse(400, null, `Insufficient available balance. You have $${totalPending.toFixed(2)} in pending withdrawals.`));
    }

    // Create strictly pending transaction
    const withdrawal = await Transaction.create({
        userId,
        type: 'withdrawal',
        status: 'pending', // VERY IMPORTANT: Admin must approve to deduct
        amount,
        note: `Withdrawal request to ${methodType}`,
        withdrawalMethod: {
            type: methodType,
            details: methodDetails
        }
    });

    res.status(201).json(new ApiResponse(201, withdrawal, 'Withdrawal request submitted for Admin review'));
});

export default {
    getWalletDashboard,
    linkReferral,
    requestWithdrawal
};
