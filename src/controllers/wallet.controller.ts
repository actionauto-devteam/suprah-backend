import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import User, { IUser } from '../models/User.model';
import Referral from '../models/referral.model';
import Transaction from '../models/transaction.model';

// 1. Get Wallet Dashboard Data
const getWalletDashboard = asyncHandler(async (req: Request, res: Response) => {
    const userClerkId = (req.user as IUser).clerkId;

    if (!userClerkId) {
        return res.status(401).json(new ApiResponse(401, null, 'User Clerk ID not found'));
    }

    // A. User Wallet Data
    const user = await User.findOne({ clerkId: userClerkId }).select('walletBalance totalEarned referralCode').lean();
    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    // B. Pending Leads Count (How many people have they referred)
    const pendingLeadsCount = await Referral.countDocuments({ referrerClerkId: userClerkId });

    // C. Recent Transaction Ledger
    const transactions = await Transaction.find({ userClerkId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

    res.json(new ApiResponse(200, {
        walletBalance: user.walletBalance,
        totalEarned: user.totalEarned,
        referralCode: user.referralCode,
        pendingLeads: pendingLeadsCount,
        recentTransactions: transactions
    }, 'Wallet dashboard fetched successfully'));
});

// 2. Link a New Referral
const linkReferral = asyncHandler(async (req: Request, res: Response) => {
    const { referralCode } = req.body;
    const newUserId = (req.user as IUser).clerkId;

    if (!referralCode || !newUserId) {
        return res.status(400).json(new ApiResponse(400, null, 'Referral code and User ID required'));
    }

    // Validate the referral code belongs to a real user
    const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });

    if (!referrer || !referrer.clerkId) {
        return res.status(404).json(new ApiResponse(404, null, 'Invalid referral code'));
    }

    if (referrer.clerkId === newUserId) {
        return res.status(400).json(new ApiResponse(400, null, 'You cannot refer yourself'));
    }

    // Check if this user was already referred
    const existingReferral = await Referral.findOne({ referredUserClerkId: newUserId });
    if (existingReferral) {
        return res.status(400).json(new ApiResponse(400, null, 'You have already been referred'));
    }

    // Create the Referral link
    const newReferral = await Referral.create({
        referrerClerkId: referrer.clerkId,
        referredUserClerkId: newUserId,
        referralCodeUsed: referrer.referralCode
    });

    // TODO: Trigger Email/Push Notification to `referrer.email` letting them know someone joined!
    console.log(`[Referral Engine] SUCCESS: User ${newUserId} joined via ${referrer.name}'s link (${referralCode})!`);

    res.status(201).json(new ApiResponse(201, newReferral, 'Referral linked successfully'));
});

// 3. Request a Withdrawal
const requestWithdrawal = asyncHandler(async (req: Request, res: Response) => {
    const { amount, methodType, methodDetails } = req.body;
    const userClerkId = (req.user as IUser).clerkId;

    if (!amount || amount <= 0 || !methodType || !methodDetails) {
        return res.status(400).json(new ApiResponse(400, null, 'Amount, withdrawal method, and details are required'));
    }

    const user = await User.findOne({ clerkId: userClerkId });
    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    if (user.walletBalance < amount) {
        return res.status(400).json(new ApiResponse(400, null, 'Insufficient wallet balance'));
    }

    // Create strictly pending transaction
    const withdrawal = await Transaction.create({
        userClerkId,
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
