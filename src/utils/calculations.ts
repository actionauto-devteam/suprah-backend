import axios from "axios";
import logger from "./logger";
import { cacheService } from "../services/cache.service";

interface Coordinates {
    lat: number;
    lon: number;
}

interface ETARange {
    min: number;
    max: number;
}

/**
 * Get coordinates from a US ZIP code using zippopotam.us —
 * a free, dedicated ZIP geocoding API with no rate limits or API key.
 * Falls back to Nominatim if zippopotam returns no result.
 */
export async function getCoordinatesFromZip(zipCode: string): Promise<Coordinates | null> {
    const cacheKey = `zip:coords:${zipCode}`;
    const cached = await cacheService.get<Coordinates>(cacheKey);
    if (cached) return cached;

    let result: Coordinates | null = null;

    // Primary: zippopotam.us — reliable for all US ZIP codes
    try {
        const res = await axios.get(
            `https://api.zippopotam.us/us/${zipCode}`,
            { timeout: 8000 }
        );
        const place = res.data?.places?.[0];
        if (place) {
            result = {
                lat: parseFloat(place.latitude),
                lon: parseFloat(place.longitude),
            };
        }
    } catch {
        // fall through to Nominatim backup
    }

    // Fallback: Nominatim
    if (!result) {
        try {
            const res = await axios.get(
                `https://nominatim.openstreetmap.org/search?postalcode=${zipCode}&country=US&format=json&limit=1`,
                {
                    headers: { "User-Agent": "VehicleShippingApp/1.0" },
                    timeout: 8000,
                }
            );
            if (res.data?.length > 0) {
                result = {
                    lat: parseFloat(res.data[0].lat),
                    lon: parseFloat(res.data[0].lon),
                };
            }
        } catch (error) {
            logger.error({ error, zipCode }, "Error fetching coordinates for ZIP");
        }
    }

    if (result) await cacheService.set(cacheKey, result, 86400 * 7); // 7 days
    return result;
}

/** Fetches coordinates for two ZIPs in parallel — zippopotam.us has no rate limits. */
export async function getCoordinatesForPair(
    zipA: string,
    zipB: string
): Promise<[Coordinates | null, Coordinates | null]> {
    return Promise.all([getCoordinatesFromZip(zipA), getCoordinatesFromZip(zipB)]);
}

/**
 * Calculate distance between two coordinates using Haversine formula
 */
export function calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const R = 3959; // Earth's radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return Math.round(distance);
}

function toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
}

/**
 * Calculate shipping rate based on distance, units, and options
 */
export function calculateRate(
    miles: number,
    units: number = 1,
    enclosedTrailer: boolean = false,
    vehicleInoperable: boolean = false
): number {
    // Base rate calculation - $1.50 per mile
    let baseRate = 1.50 * miles;

    // Minimum rate
    if (baseRate < 300) {
        baseRate = 300;
    }

    // Enclosed trailer adds 40%
    if (enclosedTrailer) {
        baseRate *= 1.4;
    }

    // Inoperable vehicle adds 20%
    if (vehicleInoperable) {
        baseRate *= 1.2;
    }

    // Multiple units discount
    const totalRate = baseRate * units * (1 - (units - 1) * 0.05);

    return Math.round(totalRate);
}

/**
 * Calculate estimated time of arrival based on distance
 */
export function calculateETA(miles: number): ETARange {
    // Average 450 miles per day for transport
    const avgMilesPerDay = 450;
    const days = miles / avgMilesPerDay;

    // Add buffer time for pickup/delivery
    const minDays = Math.ceil(days) + 1;
    const maxDays = Math.ceil(days) + 3;

    return {
        min: minDays,
        max: maxDays
    };
}