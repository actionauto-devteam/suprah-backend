import ftpService, { RawVehicleData } from './ftp.service';
import Vehicle from '../models/Vehicle.model';
import SyncLog from '../models/SyncLog.model';
import AuditLog from '../models/AuditLog.model';
import cacheService from './cache.service';
import { diff } from 'deep-diff';
import mongoose from 'mongoose';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import config from '../config';

/**
 * The internal organization ID for Action Auto Utah.
 * All vehicles synced via FTP are owned by this org.
 */
const ACTION_AUTO_ORG_ID = '69d6a26499bee4596c1ea94c';

export class SyncService {
    async syncInventory(): Promise<any> {
        const startTime = new Date();
        const syncLog = await SyncLog.create({
            startTime,
            status: 'RUNNING',
            organizationId: ACTION_AUTO_ORG_ID,
        });

        try {
            // 1. Fetch from FTP and Pipe to Parser
            const stream = await ftpService.getInventoryStream();
            const result = await this.processStream(stream, syncLog);

            // 2. Finalize sync log
            syncLog.status = 'COMPLETED';
            syncLog.endTime = new Date();
            await syncLog.save();

            // 3. Invalidate vehicle cache
            await cacheService.invalidateByPrefix('veh:');
            console.log(`[SyncService] ✅ Sync complete — invalidated vehicle cache.`);

            return result;

        } catch (error: any) {
            syncLog.status = 'FAILED';
            syncLog.errorMessage = error.message;
            syncLog.stackTrace = error.stack;
            syncLog.endTime = new Date();
            await syncLog.save();
            throw error;
        }
    }

    /**
     * Syncs a single vehicle record
     */
    private async syncVehicle(raw: RawVehicleData) {
        const existingVehicle = await Vehicle.findOne({ vin: raw.vin });

        // Helper for robust number parsing
        const parseNum = (val: string) => {
            if (!val) return undefined;
            const parsed = parseFloat(val.replace(/[^0-9.]/g, ''));
            return isNaN(parsed) ? 0 : parsed;
        };

        // Helper for boolean parsing
        const parseBool = (val: string) => {
            if (!val) return false;
            const normalized = val.toLowerCase().trim();
            return normalized === 'yes' || normalized === 'true' || normalized === '1' || normalized === 'y';
        };

        // Helper for image array
        const parseImages = (val: string) => {
            if (!val) return [];
            return val.split(',').map(url => url.trim()).filter(url => url.length > 0);
        };

        // 1. Data Sanitization & Validation
        if (!raw.vin || raw.vin.trim().toLowerCase() === 'vin' || raw.vin.length < 5) {
            return { type: 'none' }; // Skip headers and empty rows
        }

        const cleanStock = (val: string) => {
            if (!val) return undefined;
            const trimmed = val.trim();
            return trimmed.length > 50 ? trimmed.substring(0, 50) : trimmed;
        };

        const vehicleData = {
            vin: raw.vin.trim().toUpperCase(),
            year: Math.floor(parseNum(raw.year) || 0),
            make: raw.make?.trim(),
            modelName: raw.model?.trim(),
            trim: raw.trim?.trim(),
            exteriorColor: raw['exterior color']?.trim(),
            interiorColor: raw['interior color']?.trim(),
            stockNumber: cleanStock(raw['stock number']),
            vehicleType: raw.vehicletype?.trim(),

            price: parseNum(raw.price),
            mileage: parseNum(raw.mileage),
            engine: raw.engine?.trim(),
            transmission: raw['transmission type']?.trim(),
            options: raw['installed options']?.trim(),
            comments: raw['dealer comments on vehicle']?.trim(),
            images: parseImages(raw['picture urls']),
            vdpUrl: raw.vdp_vin_url?.trim(),

            certified: parseBool(raw.certified),
            isNewVehicle: parseBool(raw['is new']),

            dealerZip: raw['dealer zip']?.trim(),
            dealerEmail: raw['dealer crm email']?.trim(),

            status: 'Ready for Sale' as const,
            isDeleted: false, // Re-activate if it was deleted

            // ── Multi-tenant binding ─────────────────────────────────────────
            organizationId: ACTION_AUTO_ORG_ID,
        };

        if (!existingVehicle) {
            // Create New
            const newVehicle = await Vehicle.create(vehicleData);

            await AuditLog.create({
                entityType: 'Vehicle',
                entityId: newVehicle._id,
                action: 'CREATE',
                reason: 'New vehicle found in DealersCloud feed',
                changes: vehicleData,
                organizationId: ACTION_AUTO_ORG_ID,
            });

            return { type: 'added' };
        }

        // Compare and Update (Selective comparison to minimize noise)
        const oldData: any = {};
        // Exclude organizationId from diff — we always enforce it
        const relevantKeys = Object.keys(vehicleData).filter(k => k !== 'isDeleted' && k !== 'organizationId');

        // Respect Manual Lock for Status
        if (existingVehicle.manualStatusLock) {
            delete (vehicleData as any).status;
        }

        relevantKeys.forEach(k => {
            oldData[k] = (existingVehicle as any)[k];
        });

        const changes = diff(oldData, vehicleData);

        if (changes) {
            await Vehicle.updateOne({ _id: existingVehicle._id }, vehicleData);

            await AuditLog.create({
                entityType: 'Vehicle',
                entityId: existingVehicle._id,
                action: 'UPDATE',
                reason: 'Data updated from DealersCloud feed',
                changes: changes,
                organizationId: ACTION_AUTO_ORG_ID,
            });

            return { type: 'updated' };
        }

        return { type: 'none' };
    }

    /**
     * Process an inventory file directly from R2 (called by FTP server STOR event)
     */
    async processR2File(key: string): Promise<any> {
        const startTime = new Date();
        const syncLog = await SyncLog.create({
            startTime,
            status: 'RUNNING',
            organizationId: ACTION_AUTO_ORG_ID,
            errorMessage: `Source: R2://${key}`
        });

        const s3Client = new S3Client({
            region: 'auto',
            endpoint: config.r2.endpoint,
            credentials: {
                accessKeyId: config.r2.accessKeyId,
                secretAccessKey: config.r2.secretAccessKey,
            },
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });

        try {
            const command = new GetObjectCommand({
                Bucket: config.r2.buckets.ftp,
                Key: key,
            });
            const response = await s3Client.send(command);
            const stream = response.Body as Readable;

            const result = await this.processStream(stream, syncLog);

            // Finalize
            syncLog.status = 'COMPLETED';
            syncLog.endTime = new Date();
            await syncLog.save();

            await cacheService.invalidateByPrefix('veh:');
            return result;
        } catch (error: any) {
            syncLog.status = 'FAILED';
            syncLog.errorMessage = error.message;
            syncLog.endTime = new Date();
            await syncLog.save();
            throw error;
        }
    }

    /**
     * Shared streaming processor to handle CSV/TSV without loading full file into memory
     */
    private async processStream(stream: Readable, syncLog: any): Promise<any> {
        return new Promise((resolve, reject) => {
            let processed = 0;
            let added = 0;
            let updated = 0;
            const csvVins = new Set<string>();

            const parser = stream.pipe(
                parse({
                    columns: (header) => header.map((h: string) => h.trim().toLowerCase()),
                    skip_empty_lines: true,
                    trim: true,
                    relax_quotes: true,
                    relax_column_count: true,
                    skip_records_with_error: true,
                    delimiter: '\t', // DealersCloud TSV format
                })
            );

            parser.on('data', async (rawVehicle) => {
                parser.pause(); // Backpressure: Pause stream while we process DB update
                try {
                    const result = await this.syncVehicle(rawVehicle);
                    if (result.type === 'added') added++;
                    if (result.type === 'updated') updated++;
                    if (rawVehicle.vin) csvVins.add(rawVehicle.vin.trim().toUpperCase());
                    processed++;
                } catch (err) {
                    console.error('[SyncService] Stream processing error for vehicle:', err);
                }
                parser.resume();
            });

            parser.on('end', async () => {
                try {
                    const deletionResult = await this.handleDeletions(csvVins);

                    syncLog.vehiclesProcessed = processed;
                    syncLog.vehiclesAdded = added;
                    syncLog.vehiclesUpdated = updated;
                    syncLog.vehiclesDeleted = deletionResult.deletedCount;

                    resolve({ added, updated, deleted: deletionResult.deletedCount, processed });
                } catch (err) {
                    reject(err);
                }
            });

            parser.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * @deprecated Use processR2File or processStream
     */
    async processLocalFile(filePath: string): Promise<any> {
        // ... kept as legacy fallback but refactored to use stream
        const fs = require('fs');
        const stream = fs.createReadStream(filePath);
        return this.processStream(stream, { save: () => { } });
    }

    /**
     * Soft-deletes vehicles missing from the current feed.
     * SCOPED TO ACTION AUTO UTAH ORG ONLY — will never touch other orgs' inventory.
     */
    private async handleDeletions(csvVins: Set<string>) {
        const vehiclesToMarkSold = await Vehicle.find({
            vin: { $nin: Array.from(csvVins) },
            organizationId: ACTION_AUTO_ORG_ID, // ← Strict org scope
            status: { $ne: 'Sold' },
            manualStatusLock: { $ne: true },
            isDeleted: false
        });

        for (const vehicle of vehiclesToMarkSold) {
            vehicle.status = 'Sold';
            vehicle.dateSold = new Date();
            await vehicle.save();

            await AuditLog.create({
                entityType: 'Vehicle',
                entityId: vehicle._id,
                action: 'UPDATE',
                reason: 'Vehicle no longer present in DealersCloud source feed - marking as Sold',
                changes: { status: 'Sold' },
                organizationId: ACTION_AUTO_ORG_ID,
            });
        }

        return { deletedCount: vehiclesToMarkSold.length };
    }
}

export default new SyncService();
