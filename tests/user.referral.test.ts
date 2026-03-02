import mongoose from 'mongoose';
import User from '../src/models/User.model';

describe('User Model - Referral Engine Integration', () => {

    beforeAll(async () => {
        // Connect to a local test database or use the existing mock structure if set globally
        // For standard mongoose tests that only check model hooks, we can mock the save
        // But since this project uses a real test DB connection in CI, we will clear it
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }
    });

    afterAll(async () => {
        await User.deleteMany({ email: { $regex: 'referral_test' } });
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    test('should initialize walletBalance and totalEarned to 0 for new users', async () => {
        const user = new User({
            name: 'John Doe',
            email: 'john.referral_test@example.com',
            clerkId: 'test_clerk_john',
            password: 'password123',
            role: 'customer'
        });

        const savedUser = await user.save();
        expect(savedUser.walletBalance).toBe(0);
        expect(savedUser.totalEarned).toBe(0);
    });

    test('should automatically generate a unique AAU referral code on creation', async () => {
        const user = new User({
            name: 'Jane Smith',
            email: 'jane.referral_test@example.com',
            clerkId: 'test_clerk_jane',
            password: 'password123',
            role: 'customer'
        });

        const savedUser = await user.save();

        // Ensure the referral code was generated
        expect(savedUser.referralCode).toBeDefined();
        // Ensure it follows the AAU-NAME-XXX format
        expect(savedUser.referralCode).toMatch(/^AAU-JANE-\d{3,4}$/);
    });

    test('should extract a valid base name even with complex names', async () => {
        const user = new User({
            name: 'Dr. Michael-O\'Connor Jr.',
            email: 'michael.referral_test@example.com',
            clerkId: 'test_clerk_michael',
            password: 'password123',
            role: 'customer'
        });

        const savedUser = await user.save();

        expect(savedUser.referralCode).toBeDefined();
        // The regex `/[^a-zA-Z]/g` should strip the Dr. and just give DR
        // The split(' ')[0] gets "Dr." -> "DR"
        expect(savedUser.referralCode).toMatch(/^AAU-[A-Z]+-\d{3,4}$/);
    });
});
