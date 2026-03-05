import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import User from '../models/User.model';
import Referral from '../models/referral.model';
import Transaction from '../models/transaction.model';
import AuditLog from '../models/AuditLog.model';
import Shipment from '../models/Shipment.model';
import Payment from '../models/Payment.model';
import mongoose from 'mongoose';

// 1. Issue a Manual Reward to a Referrer
const issueReward = asyncHandler(async (req: Request, res: Response) => {
    const { referralId } = req.params;
    const { amount = 200 } = req.body;
    const adminClerkId = (req.user as any).clerkId; // Assuming admin check in middleware

    if (!amount || amount <= 0) {
        return res.status(400).json(new ApiResponse(400, null, 'Valid reward amount required'));
    }

    const referral = await Referral.findById(referralId);
    if (!referral) {
        return res.status(404).json(new ApiResponse(404, null, 'Referral not found'));
    }

    const referrer = await User.findOne({ clerkId: referral.referrerClerkId });
    if (!referrer) {
        return res.status(404).json(new ApiResponse(404, null, 'Referrer account no longer exists'));
    }

    // Use a transaction session for financial consistency if replica set allows, but we'll do standard serial here for simplicity in this env

    // A. Create the completed deposit transaction
    const deposit = await Transaction.create({
        userClerkId: referrer.clerkId,
        type: 'deposit',
        status: 'completed',
        amount: Number(amount),
        note: `Referral Bonus for linking ${referral.referredUserClerkId}`,
        referralId: referral._id
    });

    // B. Increment the wallet exactly by the deposit amount
    const updatedUser = await User.findOneAndUpdate(
        { clerkId: referrer.clerkId },
        {
            $inc: {
                walletBalance: Number(amount),
                totalEarned: Number(amount)
            }
        },
        { new: true }
    );

    // C. Write to Audit Log
    await AuditLog.create({
        entityType: 'Referral',
        entityId: referral._id,
        action: 'APPROVE_REWARD',
        reason: `Admin manually issued ${amount} reward`,
        performedBy: (req.user as any)._id,
        changes: { amount, transactionId: deposit._id }
    });

    res.json(new ApiResponse(200, { transaction: deposit, newBalance: updatedUser?.walletBalance }, 'Reward issued successfully'));
});

// 2. Get All Pending Withdrawals
const getPendingWithdrawals = asyncHandler(async (req: Request, res: Response) => {
    const pendingWithdrawals = await Transaction.find({ type: 'withdrawal', status: 'pending' })
        .sort({ createdAt: 1 })
        .lean();

    // Attach user information
    const enrichedWithdrawals = await Promise.all(pendingWithdrawals.map(async (trx) => {
        const user = await User.findOne({ clerkId: trx.userClerkId }).select('name email').lean();
        return { ...trx, user };
    }));

    res.json(new ApiResponse(200, enrichedWithdrawals, 'Pending withdrawals fetched successfully'));
});

// 3. Approve a Withdrawal Request
const approveWithdrawal = asyncHandler(async (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const adminClerkId = (req.user as any).clerkId;

    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
        return res.status(404).json(new ApiResponse(404, null, 'Transaction not found'));
    }

    if (transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
        return res.status(400).json(new ApiResponse(400, null, 'Transaction is not a pending withdrawal'));
    }

    const user = await User.findOne({ clerkId: transaction.userClerkId });
    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User no longer exists'));
    }

    if (user.walletBalance < transaction.amount) {
        // Edge case: They spent/lost money since requesting
        return res.status(400).json(new ApiResponse(400, null, 'User no longer has sufficient balance for this withdrawal'));
    }

    // A. Mark transaction as completed
    transaction.status = 'completed';
    await transaction.save();

    // B. Deduct money from wallet
    const updatedUser = await User.findOneAndUpdate(
        { clerkId: transaction.userClerkId },
        { $inc: { walletBalance: -Math.abs(transaction.amount) } },
        { new: true }
    );

    // C. Write to Audit Log
    await AuditLog.create({
        entityType: 'Transaction',
        entityId: transaction._id,
        action: 'APPROVE_WITHDRAWAL',
        reason: `Admin physically transferred funds via ${transaction.withdrawalMethod?.type || 'unknown'}`,
        performedBy: (req.user as any)._id,
        changes: { transactionStatus: 'completed', deductedAmount: transaction.amount }
    });

    res.json(new ApiResponse(200, { transaction, newBalance: updatedUser?.walletBalance }, 'Withdrawal approved and funds deducted'));
});

// 4. Reject a Withdrawal Request
const rejectWithdrawal = asyncHandler(async (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const { reason = 'Denied by administrator' } = req.body;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
        return res.status(400).json(new ApiResponse(400, null, 'Invalid or non-pending withdrawal request'));
    }

    transaction.status = 'rejected';
    transaction.note = `${transaction.note} (REJECTED: ${reason})`;
    await transaction.save();

    res.json(new ApiResponse(200, transaction, 'Withdrawal request rejected'));
});

// 5. Get Audit Detail for a Withdrawal (Credit Lineage)
const getWithdrawalAudit = asyncHandler(async (req: Request, res: Response) => {
    const { transactionId } = req.params;

    const transaction = await Transaction.findById(transactionId).lean();
    if (!transaction) {
        return res.status(404).json(new ApiResponse(404, null, 'Transaction not found'));
    }

    // Fetch all successful referral deposits for this user to show "Evidence of Earnings"
    const earnings = await Transaction.find({
        userClerkId: transaction.userClerkId,
        type: 'deposit',
        status: 'completed'
    })
        .sort({ createdAt: -1 })
        .lean();

    // Enriched earnings with user name from referral
    const enrichedEarnings = await Promise.all(earnings.map(async (e) => {
        let referralInfo = null;
        if (e.referralId) {
            const referral = await Referral.findById(e.referralId).lean();
            if (referral) {
                const referredUser = await User.findOne({ clerkId: referral.referredUserClerkId }).select('name email').lean();
                referralInfo = {
                    name: referredUser?.name || 'Unknown',
                    email: referredUser?.email || 'N/A',
                    dateJoined: referral.createdAt
                };
            }
        }

        // Fetch linked Shipment and Payment for "Full Receipt" verification
        let shipmentInfo = null;
        if (e.shipmentId) {
            shipmentInfo = await Shipment.findById(e.shipmentId).select('trackingNumber status origin destination').lean();
        }

        let paymentInfo = null;
        if (e.paymentId) {
            paymentInfo = await Payment.findById(e.paymentId).select('amount status stripeChargeId receiptUrl createdAt invoiceNumber').lean();
        }

        return { ...e, referralInfo, shipmentInfo, paymentInfo };
    }));

    res.json(new ApiResponse(200, {
        request: transaction,
        lineage: enrichedEarnings
    }, 'Audit lineage fetched successfully'));
});

export default {
    issueReward,
    getPendingWithdrawals,
    approveWithdrawal,
    rejectWithdrawal,
    getWithdrawalAudit
};
