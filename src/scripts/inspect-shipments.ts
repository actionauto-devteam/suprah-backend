import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

// Manually import models
import '../models/Shipment.model';

async function inspect() {
    try {
        await mongoose.connect(process.env.MONGODB_URI!);
        const Shipment = mongoose.model('Shipment');

        const ships = await Shipment.find({}).limit(10).lean();
        console.log(`🔎 Inspecting ${ships.length} Shipments:`);

        ships.forEach((s: any) => {
            console.log(`- Shipment: ${s._id}`);
            console.log(`  organizationId (string): ${s.organizationId}`);
            console.log(`  status: ${s.status}`);
            console.log('---');
        });

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

inspect();
