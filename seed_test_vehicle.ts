import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { OwnedVehicle } from './src/models/OwnedVehicle.model';

// Load env vars
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

if (!MONGO_URI) {
    console.error('No MongoDB URI found in .env');
    process.exit(1);
}

const seedCamaro = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('MongoDB Connected...');

        // The user ID provided by the user
        const userId = new mongoose.Types.ObjectId('699dbf32764bc579b6806f5c');

        // Remove old test vehicles for this user to avoid duplicates if rerun
        await OwnedVehicle.deleteMany({ userId });

        // Ensure the year is passed as string since model accepts string
        const vehicle = await OwnedVehicle.create({
            userId,
            vin: "2G1FK1EJ3F9107160",
            year: "2015",
            make: "CHEVROLET",
            model: "CAMARO",
            trim: "2SS",
            color: "Silver",
            currentMileage: 53007,
            status: 'ACTIVE',
            images: [
                "https://dealerscloud.blob.core.windows.net/actionauto/2G1FK1EJ3F9107160/16.jpg?v=020240424134217",
                "https://dealerscloud.blob.core.windows.net/actionauto/2G1FK1EJ3F9107160/2.jpg?v=120240422202628",
                "https://dealerscloud.blob.core.windows.net/actionauto/2G1FK1EJ3F9107160/3.jpg?v=220240422202629",
            ]
        });

        console.log('Successfully seeded 2015 Chevrolet Camaro:');
        console.log(vehicle);

    } catch (error) {
        console.error('Error seeding vehicle:', error);
    } finally {
        process.exit(0);
    }
};

seedCamaro();
