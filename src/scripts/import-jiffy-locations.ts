import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import path from 'path';
import dotenv from 'dotenv';
import ServiceLocation from '../models/ServiceLocation.model';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || '';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function geocodeAddress(addressStr: string): Promise<[number, number]> {
    try {
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

