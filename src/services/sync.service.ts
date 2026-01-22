import ftpService, { RawVehicleData } from './ftp.service';
import Vehicle from '../models/Vehicle.model';
import SyncLog from '../models/SyncLog.model';
import AuditLog from '../models/AuditLog.model';
import { diff } from 'deep-diff';
import mongoose from 'mongoose';

export class SyncService {
    /**
     * Main entry point for inventory synchronization
     */
    async syncInventory(): Promise<any> {
        const startTime = new Date();
        const syncLog = await SyncLog.create({ startTime, status: 'RUNNING' });

        try {
            // 1. Fetch and Parse
            const stream = await ftpService.getInventoryStream();
            const rawData = await ftpService.parseInventoryFile(stream);

            syncLog.vehiclesProcessed = rawData.length;
            await syncLog.save();

            const csvVins = new Set(rawData.map(v => v.VIN));
            let added = 0;
            let updated = 0;

            // 2. Process Additions and Updates
            for (const rawVehicle of rawData) {
                const result = await this.syncVehicle(rawVehicle);
                if (result.type === 'added') added++;
                if (result.type === 'updated') updated++;
            }

            // 3. Process Deletions (Soft-delete vehicles not in CSV)
            const deletionResult = await this.handleDeletions(csvVins);

            // 4. Finalize
            syncLog.vehiclesAdded = added;
            syncLog.vehiclesUpdated = updated;
            syncLog.vehiclesDeleted = deletionResult.deletedCount;
            syncLog.status = 'COMPLETED';
            syncLog.endTime = new Date();
            await syncLog.save();

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
        const existingVehicle = await Vehicle.findOne({ vin: raw.VIN });

        const vehicleData = {
            vin: raw.VIN,
            year: parseInt(raw.Year),
            make: raw.Make,
            modelName: raw.Model,
            trim: raw.Trim,
            color: raw.Color,
            stockNumber: raw.StockNumber,
            isDeleted: false // Re-activate if it was deleted
        };

        if (!existingVehicle) {
            // Create New
            const newVehicle = await Vehicle.create(vehicleData);

            await AuditLog.create({
                entityType: 'Vehicle',
                entityId: newVehicle._id,
                action: 'CREATE',
                reason: 'New vehicle found in DealersCloud feed',
                changes: vehicleData
            });

            return { type: 'added' };
        }

        // Compare and Update
        const oldData = {
            vin: existingVehicle.vin,
            year: existingVehicle.year,
            make: existingVehicle.make,
            modelName: existingVehicle.modelName,
            trim: existingVehicle.trim,
            color: existingVehicle.color,
            stockNumber: existingVehicle.stockNumber,
            isDeleted: existingVehicle.isDeleted
        };

        const changes = diff(oldData, vehicleData);

        if (changes) {
            await Vehicle.updateOne({ _id: existingVehicle._id }, vehicleData);

            await AuditLog.create({
                entityType: 'Vehicle',
                entityId: existingVehicle._id,
                action: 'UPDATE',
                reason: 'Data updated from DealersCloud feed',
                changes: changes
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
        const syncLog = await SyncLog.create({ startTime, status: 'RUNNING' });

        try {
            // Read and parse the local file
            const fs = require('fs');
            const stream = fs.createReadStream(filePath);
            const rawData = await ftpService.parseInventoryFile(stream);

            syncLog.vehiclesProcessed = rawData.length;
            await syncLog.save();

            const csvVins = new Set(rawData.map(v => v.VIN));
            let added = 0;
            let updated = 0;

            // Process Additions and Updates
            for (const rawVehicle of rawData) {
                const result = await this.syncVehicle(rawVehicle);
                if (result.type === 'added') added++;
                if (result.type === 'updated') updated++;
            }

            // Process Deletions
            const deletionResult = await this.handleDeletions(csvVins);

            // Finalize
            syncLog.vehiclesAdded = added;
            syncLog.vehiclesUpdated = updated;
            syncLog.vehiclesDeleted = deletionResult.deletedCount;
            syncLog.status = 'COMPLETED';
            syncLog.endTime = new Date();
            await syncLog.save();

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
     * Soft-deletes vehicles missing from the current feed
     */
    private async handleDeletions(csvVins: Set<string>) {
        // Find active vehicles that are NOT in the CSV
        const vehiclesToRemove = await Vehicle.find({
            vin: { $nin: Array.from(csvVins) },
            isDeleted: false
        });

        for (const vehicle of vehiclesToRemove) {
            vehicle.isDeleted = true;
            await vehicle.save();

            await AuditLog.create({
                entityType: 'Vehicle',
                entityId: vehicle._id,
                action: 'DELETE',
                reason: 'Vehicle no longer present in DealersCloud source feed',
            });
        }

        return { deletedCount: vehiclesToRemove.length };
    }
}

export default new SyncService();
