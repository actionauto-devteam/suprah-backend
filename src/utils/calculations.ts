import axios from 'axios';

interface Coordinates {
    lat: number;
    lon: number;
}

interface ETARange {
    min: number;
    max: number;
}

/**
 * Get coordinates from ZIP code using OpenStreetMap Nominatim API
 */
export async function getCoordinatesFromZip(zipCode: string): Promise<Coordinates | null> {
    try {
        const response = await axios.get(
            `https://nominatim.openstreetmap.org/search?postalcode=${zipCode}&country=US&format=json`,
            {
                headers: {
                    'User-Agent': 'VehicleShippingApp/1.0'
                }
            }
        );

        if (response.data && response.data.length > 0) {
            return {
                lat: parseFloat(response.data[0].lat),
                lon: parseFloat(response.data[0].lon)
            };
        }

        return null;
    } catch (error) {
        console.error('Error fetching coordinates:', error);
        return null;
    }
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
    // Base rate calculation
    let baseRate: number;

    if (miles <= 200) {
        baseRate = 0.75 * miles;
    } else if (miles <= 500) {
        baseRate = 0.65 * miles;
    } else if (miles <= 1000) {
        baseRate = 0.55 * miles;
    } else if (miles <= 1500) {
        baseRate = 0.50 * miles;
    } else {
        baseRate = 0.45 * miles;
    }

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