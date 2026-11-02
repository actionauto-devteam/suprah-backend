import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Vehicle from "../models/Vehicle.model";
import User from "../models/User.model";
import CrmUser from "../models/CrmUser.model";
import Organization from "../models/Organization.model";
import { OwnedVehicle } from "../models/OwnedVehicle.model";
import GarageTransfer from "../models/GarageTransfer.model";
import notificationService from "./notification.service";
import cacheService from "./cache.service";
import { emitToOrg } from "../utils/socketEmitter";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";

/*
 * "Add to customer's garage" on a delivered load (decided 2026-10-30): when a
 * customer's shipping request from the customer portal is delivered, staff
 * can put the car in that customer's My Garage. It does what the CRM's Garage
 * Review transfer does (garage entry, transfer record, car marked Sold and
 * locked so the feed doesn't put it back on sale), then tells the customer.
 * Garage Review's own code is not changed.
 */

/** The customer portal page that shows My Garage. */
export const MY_GARAGE_ROUTE = "/customer";

export type LoadGarageState =
  | { state: "available"; customerName: string; vehicleLabel: string }
  | { state: "done"; customerName: string; vehicleLabel: string }
  | { state: "other_dealership"; customerName: string; vehicleLabel: string }
  | { state: "no_inventory_car"; customerName: string };

interface GarageContext {
  quote: { _id: mongoose.Types.ObjectId; vehicleId?: mongoose.Types.ObjectId; requestedBy?: mongoose.Types.ObjectId };
  vehicle: any | null;
  customer: { _id: mongoose.Types.ObjectId; name?: string; email?: string; organizationId?: mongoose.Types.ObjectId | null };
}

export const garageVehicleLabel = (vehicle: { year?: unknown; make?: string; modelName?: string } | null | undefined) =>
  `${vehicle?.year ?? ""} ${vehicle?.make ?? ""} ${vehicle?.modelName ?? ""}`.replace(/\s+/g, " ").trim();

const cleanImages = (images: unknown): string[] =>
  Array.isArray(images) ? images.filter((image): image is string => typeof image === "string" && image.trim().length > 0) : [];

/**
 * The quote, Inventory car and customer behind a delivered customer request,
 * or null when the button doesn't apply (not delivered, not from the customer
 * portal, or the customer account is gone).
 */
async function garageContext(organizationId: string, load: any): Promise<GarageContext | null> {
  if (!load || load.status !== "Delivered" || !load.quoteId) return null;
  if (!mongoose.Types.ObjectId.isValid(String(load.quoteId))) return null;
  const quote = await Quote.findOne({ _id: load.quoteId, organizationId, source: "customer_portal" })
    .select("vehicleId requestedBy")
    .lean<GarageContext["quote"]>();
  if (!quote?.requestedBy) return null;

  const customer = await User.findOne({ _id: quote.requestedBy, role: "customer" })
    .select("name email organizationId")
    .lean<GarageContext["customer"]>();
  if (!customer) return null;

  // The car on the load that came from the request, else the load's only stock car.
  const vehicleIds = (Array.isArray(load.vehicles) ? load.vehicles : [])
    .map((vehicle: any) => String(vehicle?.vehicleId ?? ""))
    .filter((id: string) => mongoose.Types.ObjectId.isValid(id));
  const vehicleId = quote.vehicleId && vehicleIds.includes(String(quote.vehicleId))
    ? String(quote.vehicleId)
    : vehicleIds.length === 1 ? vehicleIds[0] : "";
  const vehicle = vehicleId
    ? await Vehicle.findOne({ _id: vehicleId, organizationId, isDeleted: { $ne: true } })
    : null;
  return { quote, vehicle, customer };
}

const customerNameOf = (customer: GarageContext["customer"]) => String(customer.name ?? "").trim() || "The customer";

const belongsElsewhere = (customer: GarageContext["customer"], organizationId: string) => {
  const customerOrg = String(customer.organizationId ?? "").trim();
  return Boolean(customerOrg) && customerOrg !== String(organizationId);
};

async function alreadyInGarage(context: GarageContext): Promise<boolean> {
  if (!context.vehicle?.vin) return false;
  const owned = await OwnedVehicle.exists({ userId: context.customer._id, vin: context.vehicle.vin, status: "ACTIVE" });
  return Boolean(owned);
}

/** Whether the delivered load's page shows the button, a done note or why not. Null hides everything. */
export async function loadGarageState(organizationId: string, load: any): Promise<LoadGarageState | null> {
  const context = await garageContext(organizationId, load);
  if (!context) return null;
  const customerName = customerNameOf(context.customer);
  if (!context.vehicle) return { state: "no_inventory_car", customerName };
  const vehicleLabel = garageVehicleLabel(context.vehicle);
  if (belongsElsewhere(context.customer, organizationId)) return { state: "other_dealership", customerName, vehicleLabel };
  if (await alreadyInGarage(context)) return { state: "done", customerName, vehicleLabel };
  return { state: "available", customerName, vehicleLabel };
}

/**
 * Puts a delivered customer request's car in the customer's My Garage, marks
 * it Sold, records the transfer and tells the customer. Doing it again only
 * refreshes the garage entry and sends nothing new.
 */
export async function addLoadCarToGarage(
  organizationId: string,
  load: any,
  actor: { _id: mongoose.Types.ObjectId | string; name?: string; email?: string },
): Promise<{ alreadyInGarage: boolean; vehicleMarkedSold: boolean; customerName: string; vehicleLabel: string }> {
  const context = await garageContext(organizationId, load);
  if (!load || load.status !== "Delivered") {
    throw new ApiError(400, "You can add the car to the customer's garage once the load is delivered.");
  }
  if (!context) {
    throw new ApiError(400, "Only a delivered shipping request from a customer's portal account can be added to their garage.");
  }
  const customerName = customerNameOf(context.customer);
  if (!context.vehicle) {
    throw new ApiError(400, "This car isn't in your Inventory anymore, so it can't be added to the customer's garage from here.");
  }
  if (belongsElsewhere(context.customer, organizationId)) {
    throw new ApiError(403, `${customerName} is registered with another dealership, so this car can't be added to their garage from here.`);
  }

  const vehicle = context.vehicle;
  const label = garageVehicleLabel(vehicle);
  const mileage = Number.isFinite(Number(vehicle.mileage)) && Number(vehicle.mileage) >= 0 ? Number(vehicle.mileage) : 0;
  const org = await Organization.findById(organizationId).select("name").lean<{ name?: string }>().catch(() => null);
  const dealershipName = String(org?.name ?? "").trim() || undefined;

  // The garage entry, one per customer and VIN (the same as Garage Review).
  let owned = await OwnedVehicle.findOne({ userId: context.customer._id, vin: vehicle.vin });
  const existed = Boolean(owned);
  const wasActive = owned?.status === "ACTIVE";
  if (owned) {
    owned.status = "ACTIVE";
    owned.currentMileage = Math.max(owned.currentMileage || 0, mileage);
    owned.source = "DEALERSHIP_TRANSFER";
    if (dealershipName) owned.dealershipName = dealershipName;
    (owned as any).transferredAt = new Date();
    if ((!owned.images || owned.images.length === 0) && cleanImages(vehicle.images).length) {
      owned.images = cleanImages(vehicle.images);
    }
    await owned.save();
  } else {
    try {
      owned = await OwnedVehicle.create({
        userId: context.customer._id,
        vin: vehicle.vin,
        make: vehicle.make,
        model: vehicle.modelName,
        year: String(vehicle.year),
        trim: vehicle.trim || undefined,
        color: vehicle.exteriorColor || undefined,
        currentMileage: mileage,
        images: cleanImages(vehicle.images),
        status: "ACTIVE",
        purchaseDate: new Date(),
        source: "DEALERSHIP_TRANSFER",
        dealershipName,
        transferredAt: new Date(),
      });
    } catch (err: any) {
      // A second tap at the same moment created it first.
      if (err?.code !== 11000) throw err;
      owned = await OwnedVehicle.findOne({ userId: context.customer._id, vin: vehicle.vin });
      if (!owned) throw err;
    }
  }

  // Marked Sold and locked, so the nightly feed doesn't put it back on sale.
  // A car already marked Sold at delivery still gets the lock.
  let vehicleMarkedSold = false;
  if (vehicle.status !== "Sold" || !vehicle.manualStatusLock) {
    if (vehicle.status !== "Sold") {
      vehicle.status = "Sold";
      vehicle.dateSold = new Date();
      vehicleMarkedSold = true;
    }
    vehicle.manualStatusLock = true;
    await vehicle.save();
    await cacheService.invalidateByPrefix("veh:").catch(() => undefined);
  }

  // The same transfer record Garage Review keeps, credited to the staff
  // member's CRM account when they have one.
  const crmUser = actor.email
    ? await CrmUser.findOne({ email: String(actor.email).toLowerCase(), organizationId }).select("_id fullName").lean<{ _id: mongoose.Types.ObjectId; fullName?: string }>()
    : null;
  const record = await GarageTransfer.create({
    organizationId,
    vehicleId: vehicle._id,
    ownedVehicleId: owned!._id,
    customerId: context.customer._id,
    dealId: null,
    vin: vehicle.vin,
    vehicleLabel: label,
    customerName: String(context.customer.name ?? ""),
    customerEmail: String(context.customer.email ?? ""),
    mileageAtTransfer: mileage,
    vehicleMarkedSold,
    performedBy: crmUser?._id ?? actor._id,
    performedByName: String(crmUser?.fullName || actor.name || "Staff").trim(),
    status: existed ? "already_in_garage" : "transferred",
  });

  emitToOrg(String(organizationId), "garage:vehicle_transferred", {
    transferId: record._id,
    vehicleId: vehicle._id,
    customerId: context.customer._id,
    vin: vehicle.vin,
    status: record.status,
  });

  // Told once: only when the car wasn't already in their garage.
  if (!wasActive) {
    try {
      await notificationService.createNotification({
        userId: String(context.customer._id),
        organizationId: String(organizationId),
        type: "vehicle_added",
        title: "Added to My Garage",
        message: `${dealershipName || "The dealership"} added your ${label || "vehicle"} to My Garage.`,
        metadata: { vehicleId: String(vehicle._id), route: MY_GARAGE_ROUTE },
      } as any);
    } catch (err) {
      logger.error({ err, loadId: String(load._id) }, "Non-fatal: failed to tell the customer their car was added to My Garage");
    }
  }

  return { alreadyInGarage: wasActive, vehicleMarkedSold, customerName, vehicleLabel: label };
}
