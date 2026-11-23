import '../config/productionDbGuard';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import path from 'path';
import dotenv from 'dotenv';
import ServiceLocation from '../models/ServiceLocation.model';
import { findStorePin } from '../services/storeLocationPin.service';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || '';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Pins come from a match to the house itself (US Census, then Amazon where it's
// switched on), never only a street or city (2026-11-18). A store without such
// a match is saved with 0,0, which the website doesn't show; run
// fix-service-location-pins.ts to list those stores.
const NO_PIN: [number, number] = [0, 0];

async function importLocations() {
    if (!MONGODB_URI) {
        console.error('MONGODB_URI is not defined in .env');
        process.exit(1);
    }

    try {
        const isAtlas = MONGODB_URI.includes('mongodb+srv') || MONGODB_URI.includes('mongodb.net');
        
        if (isAtlas && process.env.ALLOW_WIPE !== 'true') {
            console.error('\n\n🚨 FATAL ERROR: PARTNER DATA WIPE PREVENTED');
            console.error('--------------------------------------------');
            console.error('This script is attempting to clear and re-import Jiffy Lube locations on a Cloud Atlas cluster.');
            console.error('To protect your data, the operation has been aborted.');
            console.error('If you actually want to re-import, set ALLOW_WIPE=true.\n\n');
            process.exit(1);
        }

        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        const xlsPath = path.join(process.cwd(), 'jiffy-locations.xls');
        console.log('Reading:', xlsPath);
        
        const workbook = XLSX.readFile(xlsPath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        const data: any[] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const locationsToImport = [];

        // Start from index 2 (Skip title at 0 and header at 1)
        for (let i = 2; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length < 4) continue;

            const address = String(row[0]).trim();
            const city = String(row[1]).trim();
            const zipCode = String(row[2]).trim();
            const phone = String(row[3]).trim();

            const fullAddress = `${address}, ${city}, UT ${zipCode}`;
            console.log(`Geocoding (${i - 1}/${data.length - 2}): ${fullAddress}`);

            const found = await findStorePin({ address, city, state: 'UT', zipCode });
            if (!found.pin) console.warn(`No house-level match for ${fullAddress}; saved without a map pin`);
            const coordinates = found.pin?.coordinates ?? NO_PIN;

            // Gentle on the free Census address lookup
            await sleep(300);

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

