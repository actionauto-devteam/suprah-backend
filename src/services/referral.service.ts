import User from '../models/User.model';
import Referral from '../models/referral.model';
import Transaction from '../models/transaction.model';
import AuditLog from '../models/AuditLog.model';
import Shipment from '../models/Shipment.model';
import { IPayment } from '../models/Payment.model';
import notificationService from './notification.service';
import { notificationTemplates } from '../utils/notificationTemplates';
import activityService from './activity.service';

export class ReferralService {
    /**
     * Process a referral reward for a successful payment.
     * This logic is automated and includes duplicate prevention.
     */
    static async processPaymentReward(payment: IPayment, performedBy?: string) {
        // 1. Basic Validation: Is this a vehicle purchase?
        // We use quoteId as the primary indicator for a vehicle sale payment
        let quoteId = payment.quoteId;

        // Fallback: If no quoteId, check if it's linked to a shipment (which has a quoteId)
        if (!quoteId && payment.shipmentId) {
            console.log(`[ReferralService] Payment ${payment._id} missing quoteId. Checking shipment ${payment.shipmentId}...`);
            const shipment = await Shipment.findById(payment.shipmentId);
            if (shipment?.quoteId) {
                quoteId = shipment.quoteId;
                console.log(`[ReferralService] Resolved quoteId ${quoteId} from shipment.`);
            }
        }

        if (!quoteId) {
            console.log(`[ReferralService] Payment ${payment._id} is not linked to a quote or shipment. Skipping.`);
            return;
        }

        if (payment.status !== 'succeeded') {
            console.log(`[ReferralService] Payment ${payment._id} status is ${payment.status}. Skipping.`);
            return;
        }

        // 2. Identify the customer
        const customer = await User.findOne({ email: payment.customerEmail });
        if (!customer) {
            console.log(`[ReferralService] No user found with email ${payment.customerEmail}. Skipping.`);
            return;
        }

        // 3. Check if the customer was referred
        const referral = await Referral.findOne({ referredUserId: customer._id });
        if (!referral) {
            console.log(`[ReferralService] User ${customer._id} was not referred. Skipping.`);
            return;
        }

        // 4. Duplicate Prevention: Has a reward already been issued for this referral?
        // We check for a transaction of type 'deposit' with this referralId
        const existingReward = await Transaction.findOne({
            referralId: referral._id,
            type: 'deposit',
            status: 'completed'
        });

        if (existingReward) {
            console.log(`[ReferralService] Reward already issued for referral ${referral._id}. Skipping.`);
            return;
        }

        // 5. Identify the Referrer
        const referrer = await User.findById(referral.referrerId);
        if (!referrer) {
            console.log(`[ReferralService] Referrer (ID: ${referral.referrerId}) not found. Skipping.`);
            return;
        }

        const rewardAmount = 100;

        // 6. Execute Reward
        // A. Create Transaction
        const transaction = await Transaction.create({
            userId: referrer._id,
            type: 'deposit',
            status: 'completed',
            amount: rewardAmount,
            note: `Referral Reward: ${customer.name || customer.email} purchased a vehicle.`,
            referralId: referral._id,
            paymentId: payment._id,
            shipmentId: payment.shipmentId
        });

        // B. Update Referrer Wallet
        await User.findByIdAndUpdate(
            referrer._id,
            {
                $inc: {
                    walletBalance: rewardAmount,
                    totalEarned: rewardAmount
                }
            }
        );

        // G. Update Notification Preferences (Logic assumed to be elsewhere or here)
        // Ensure we find the right referral for final updates
        const finalReferral = await Referral.findById(referral._id);

        // Log activity (Persona: Referrer receiving reward)
        await activityService.logFinancialActivity(
            referrer._id.toString(),
            referrer.organizationId?.toString(),
            'referral_applied',
            rewardAmount,
            `Earned referral reward: ${customer.name || customer.email} purchased a vehicle.`,
            { referralId: referral._id.toString(), transactionId: transaction._id.toString() }
        );

        // C. Audit Log
        await AuditLog.create({
            entityType: 'Referral',
            entityId: referral._id,
            action: 'APPROVE_REWARD',
            reason: 'Automated referral reward for vehicle purchase',
            performedBy: performedBy,
            changes: {
                amount: rewardAmount,
                transactionId: transaction._id,
                paymentId: payment._id
            }
        });

        // D. Notify Referrer
        try {
            // Template names will be updated in next step
            if ((notificationTemplates as any).referral_rewarded) {
                const { title, message } = (notificationTemplates as any).referral_rewarded({
                    referredName: customer.name || customer.email,
                    amount: rewardAmount
                });

                await notificationService.createNotification({
                    userId: referrer._id.toString(),
                    organizationId: referrer.organizationId?.toString() || 'global',
                    type: 'referral_rewarded',
                    title,
                    message,
                    metadata: {
                        referralId: referral._id.toString(),
                        transactionId: transaction._id.toString(),
                        amount: rewardAmount
                    }
                });
            }
        } catch (error) {
            console.error('[ReferralService] Failed to send notification:', error);
        }

        console.log(`[ReferralService] Successfully issued $${rewardAmount} reward to ${referrer._id}`);
        return transaction;
    }

    /**
     * Notify referrer when a friend signs up.
     */
    static async notifyReferralSignup(referralId: string) {
        const referral = await Referral.findById(referralId);
        if (!referral) return;

        const referrer = await User.findById(referral.referrerId);
        const referredUser = await User.findById(referral.referredUserId);

        if (!referrer || !referredUser) return;

        try {
            if ((notificationTemplates as any).referral_joined) {
                const { title, message } = (notificationTemplates as any).referral_joined({
                    referredName: referredUser.name || referredUser.email
                });

                await notificationService.createNotification({
                    userId: referrer._id.toString(),
                    organizationId: referrer.organizationId?.toString() || 'global',
                    type: 'referral_joined',
                    title,
                    message,
                    metadata: {
                        referralId: referral._id.toString(),
                        referrerId: referrer._id.toString(),
                        referredUserId: referredUser._id.toString()
                    }
                });
            }
        } catch (error) {
            console.error('[ReferralService] Failed to send signup notification:', error);
        }
    }
}

export default ReferralService;
