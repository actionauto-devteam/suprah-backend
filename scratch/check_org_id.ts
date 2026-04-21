import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.join(__dirname, '../.env') });

const VehicleSchema = new mongoose.Schema({
    organizationId: String,
    make: String,
}, { strict: false });

const OrgLeadConfigSchema = new mongoose.Schema({
    organizationId: mongoose.Schema.Types.ObjectId,
    leadSourceEmail: String,
    gmailConnected: Boolean,
    isActive: Boolean,
    gmailAddress: String,
}, { strict: false });

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI!);
        const Vehicle = mongoose.model('Vehicle', VehicleSchema);
        const OrgLeadConfig = mongoose.model('OrgLeadConfig', OrgLeadConfigSchema);
        
        const vehicle = await Vehicle.findById('69da6f14672dbb38225fd01e');
        if (!vehicle) {
            console.log('Vehicle not found');
            process.exit(1);
        }

        const orgIdStr = vehicle.organizationId;
        if (!orgIdStr) {
            console.log('Vehicle has no organizationId');
            process.exit(1);
        }

        console.log('--- VEHICLE ORG ID ---');
        console.log(orgIdStr);

        // Try finding with ObjectId
        const config = await OrgLeadConfig.findOne({ 
            organizationId: new mongoose.Types.ObjectId(orgIdStr),
            isActive: true 
        });
        
        console.log('--- CONFIG ---');
        if (config) {
            console.log(JSON.stringify({
                _id: config._id,
                organizationId: config.organizationId,
                leadSourceEmail: config.leadSourceEmail,
                gmailAddress: config.gmailAddress,
                gmailConnected: config.gmailConnected,
                isActive: config.isActive
            }, null, 2));
        } else {
            console.log('No active OrgLeadConfig found for this organization ID.');
        }
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

run();
