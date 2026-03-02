import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import ServiceLocation from '../models/ServiceLocation.model';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || '';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function geocodeAddress(addressStr: string): Promise<[number, number]> {
    try {
        // Using Nominatim (OpenStreetMap) for free geocoding. 
        // We add a User-Agent as required by their terms of service.
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressStr)}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'ActionAutoApp/1.0 (Development Import Script)'
            }
        });

        if (!response.ok) {
            console.warn(`Geocoding HTTP Error ${response.status} for ${addressStr}`);
            return [0, 0];
        }

        const data: any = await response.json();

        if (data && data.length > 0) {
            return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
        }

        console.warn(`No coordinates found for ${addressStr}`);
        return [0, 0];
    } catch (e) {
        console.error(`Geocoding failed for ${addressStr}`, e);
        return [0, 0];
    }
}

async function importLocations() {
    if (!MONGODB_URI) {
        console.error('MONGODB_URI is not defined in .env');
        process.exit(1);
    }

    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        const csvPath = path.join(__dirname, '../../jiffy-locations.csv');
        const csvData = fs.readFileSync(csvPath, 'utf8');
        const lines = csvData.split('\n');

        const locationsToImport = [];

        // Skip title and header (Lines 1 and 2)
        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Use a simple split but handle potential extra commas at the end
            const parts = line.split(',');
            if (parts.length < 4) continue;

            const address = parts[0].trim();
            const city = parts[1].replace(/"/g, '').trim(); // Handle "BALLARD, UT" quotes
            const zipCode = parts[2].trim();
            const phone = parts[3].trim();

            const fullAddress = `${address}, ${city}, UT ${zipCode}`;
            console.log(`Geocoding (${i - 1}/${lines.length - 2}): ${fullAddress}`);

            const coordinates = await geocodeAddress(fullAddress);

            // Respect Nominatim's strict usage policy (absolute max 1 request/second)
            await sleep(1200);

            locationsToImport.push({
                name: `Jiffy Lube - ${city} (${address})`,
                address,
                city,
                state: 'UT',
                zipCode,
                phone,
                partnerName: 'Jiffy Lube',
                isActive: true,
                location: {
                    type: 'Point',
                    coordinates
                }
            });
        }

        console.log(`Parsed ${locationsToImport.length} locations. Starting DB Import...`);

        // Clear existing Jiffy Lube locations to avoid duplicates if re-running
        await ServiceLocation.deleteMany({ partnerName: 'Jiffy Lube' });

        const result = await ServiceLocation.insertMany(locationsToImport);
        console.log(`Successfully imported ${result.length} locations with fresh coordinates!`);

    } catch (error) {
        console.error('Import failed:', error);
    } finally {
        await mongoose.disconnect();
    }
}

importLocations();

