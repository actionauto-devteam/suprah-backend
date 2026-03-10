import mongoose from 'mongoose';
import AuthService from './src/services/auth.service';
import User from './src/models/User.model';
import DriverRequest from './src/models/DriverRequest.model';
import dotenv from 'dotenv';

dotenv.config();

async function reproduce() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/test');
    console.log('Connected to MongoDB');

    const email = `test_driver_${Date.now()}@example.com`;
    console.log(`Registering driver: ${email}`);

    try {
        const result = await AuthService.register({
            name: 'Test Driver',
            email: email,
            password: 'Password123!',
            role: 'driver'
        });

        console.log('Registration result:', result.user.role);

        const user = await User.findOne({ email });
        console.log('User role in DB:', user?.role);
        console.log('User isApproved:', user?.isApproved);
        console.log('User onboardingCompleted:', user?.onboardingCompleted);

        const request = await DriverRequest.findOne({ driverUserId: user?._id });
        if (request) {
            console.log('✅ DriverRequest found:', request._id);
        } else {
            console.log('❌ DriverRequest NOT found');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.connection.close();
    }
}

reproduce();
