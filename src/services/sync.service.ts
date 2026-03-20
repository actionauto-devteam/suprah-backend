import ftpService, { RawVehicleData } from './ftp.service';
import Vehicle from '../models/Vehicle.model';
import SyncLog from '../models/SyncLog.model';
import AuditLog from '../models/AuditLog.model';
import cacheService from './cache.service';
import { diff } from 'deep-diff';
import mongoose from 'mongoose';

/**
 * The internal organization ID for Action Auto Utah.
 * All vehicles synced via FTP are owned by this org.
 */
const ACTION_AUTO_ORG_ID = '698f516abb63af8f6eb7be4c';

export class SyncService {
    /**
     * Main entry point for inventory synchronization
     */
    async syncInventory(): Promise<any> {
        const startTime = new Date();
        const syncLog = await SyncLog.create({
            startTime,
            status: 'RUNNING',
            organizationId: ACTION_AUTO_ORG_ID,
        });

        try {
            // 1. Fetch and Parse
            const stream = await ftpService.getInventoryStream();
            const rawData = await ftpService.parseInventoryFile(stream);

            syncLog.vehiclesProcessed = rawData.length;
            await syncLog.save();

            const csvVins = new Set(rawData.map(v => v.vin));
            let added = 0;
            let updated = 0;

            // 2. Process Additions and Updates
            for (const rawVehicle of rawData) {
                const result = await this.syncVehicle(rawVehicle);
                if (result.type === 'added') added++;
                if (result.type === 'updated') updated++;
            }

            // 3. Process Deletions (Soft-delete vehicles not in CSV, scoped to this org)
            const deletionResult = await this.handleDeletions(csvVins);

            // 4. Finalize sync log
            syncLog.vehiclesAdded = added;
            syncLog.vehiclesUpdated = updated;
            syncLog.vehiclesDeleted = deletionResult.deletedCount;
            syncLog.status = 'COMPLETED';
            syncLog.endTime = new Date();
            await syncLog.save();

            // 5. Invalidate vehicle cache so the API serves fresh data
            await cacheService.invalidateByPrefix('veh:');
            console.log(`[SyncService] ✅ Sync complete — invalidated vehicle cache.`);

            return {
                added,
                updated,
                deleted: deletionResult.deletedCount,
                processed: rawData.length
            };

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
     * Process a locally uploaded file (from FTP server)
     */
    async processLocalFile(filePath: string): Promise<any> {
        const startTime = new Date();
        const syncLog = await SyncLog.create({
            startTime,
            status: 'RUNNING',
            organizationId: ACTION_AUTO_ORG_ID,
        });

        try {
            // Read and parse the local file
            const fs = require('fs');
            const stream = fs.createReadStream(filePath);
            const rawData = await ftpService.parseInventoryFile(stream);

            syncLog.vehiclesProcessed = rawData.length;
            await syncLog.save();

            const csvVins = new Set(rawData.map(v => v.vin));
            let added = 0;
            let updated = 0;

            // Process Additions and Updates
            for (const rawVehicle of rawData) {
                const result = await this.syncVehicle(rawVehicle);
                if (result.type === 'added') added++;
                if (result.type === 'updated') updated++;
            }

            // Process Deletions (scoped to this org only)
            const deletionResult = await this.handleDeletions(csvVins);

            // Finalize
            syncLog.vehiclesAdded = added;
            syncLog.vehiclesUpdated = updated;
            syncLog.vehiclesDeleted = deletionResult.deletedCount;
            syncLog.status = 'COMPLETED';
            syncLog.endTime = new Date();
            await syncLog.save();

            // Invalidate vehicle cache after successful local file sync
            await cacheService.invalidateByPrefix('veh:');
            console.log(`[SyncService] ✅ Local file sync complete — invalidated vehicle cache.`);

            return {
                added,
                updated,
                deleted: deletionResult.deletedCount,
                processed: rawData.length
            };

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
