import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables early
dotenv.config({ path: path.join(__dirname, '../../../.env') });
import config from '../config';

import User from '../models/User.model';
import Organization from '../models/Organization.model';

/**
 * Migration Script: Update Legacy User Roles
 * 
 * If a user belongs to an Organization (has organizationId):
 * - If their organizationRole is 'admin' or 'owner', update their global role to 'admin'
 * - Otherwise, update their global role to 'employee'
 * 
 * Users without an organization will remain untouched (e.g., 'customer', 'driver').
 */
async function run() {
    try {
        console.log(`Connecting to MongoDB at: ${config.mongoose.url}`);
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto');
        console.log('✅ Connected to MongoDB');

        // Find all users who are currently attached to an organization
        const orgUsers = await User.find({ organizationId: { $exists: true, $ne: null } });
        console.log(`Found ${orgUsers.length} users attached to an organization.`);

        let updatedToAdmin = 0;
        let updatedToEmployee = 0;
        let skippedCount = 0;

        for (const user of orgUsers) {
            // By default, if they have an org, they should at least be an 'employee'
            let newRole = 'employee';

            // If their specific role inside the org is admin, elevate their global role
            const orgRole = (user as any).organizationRole || '';
            const isAdmin = ['admin', 'owner', 'manager'].includes(orgRole.toLowerCase());

            if (isAdmin) {
                newRole = 'admin';
            }

            // Super admins should never be downgraded by this script
            if (user.role === 'super_admin') {
                console.log(`[SKIPPED] User ${user.email} is a super_admin. Leaving untouched.`);
                skippedCount++;
                continue;
            }

            if (user.role !== newRole || !user.onboardingCompleted) {
                console.log(`[UPDATING] User ${user.email} from '${user.role}' to '${newRole}' (OrgRole: '${orgRole}')`);
                user.role = newRole as any; // Cast for Mongoose enum
                user.onboardingCompleted = true;
                await user.save();

                if (newRole === 'admin') updatedToAdmin++;
                if (newRole === 'employee') updatedToEmployee++;
            } else {
                skippedCount++;
            }
        }

        console.log('\n=======================================');
        console.log('✅ Role Synchronization Complete!');
        console.log(`   - Upgraded to 'admin': ${updatedToAdmin}`);
        console.log(`   - Set to 'employee': ${updatedToEmployee}`);
        console.log(`   - Skipped (already correct or super_admin): ${skippedCount}`);
        console.log('=======================================\n');

    } catch (error) {
        console.error('❌ Migration failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('MongoDB connection closed.');
        process.exit(0);
    }
}

// Execute the function
run();
