/*
 * Amazon Location Service: snapping driver routes to roads, and arrival
 * times (ETA) with live traffic.
 *
 * Both are off unless switched on. While off (or if a request fails), route
 * lines use the cleaned GPS points and no arrival time is shown.
 *
 * AWS access uses the standard AWS credential chain: on the production EC2
 * server that's the server's IAM role, which needs permission for
 * geo-routes:SnapToRoads (route lines), geo-routes:CalculateRoutes and
 * geo-places:Geocode (arrival times). No key is stored in the code.
 *
 *   AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED  "true" to snap route lines to roads
 *   AMAZON_LOCATION_ETA_ENABLED            "true" to show arrival times with traffic
 *   AMAZON_LOCATION_REGION                 AWS region (default AWS_REGION, then us-west-2)
 *   AMAZON_LOCATION_TRAVEL_MODE            "Truck" (default) or "Car"
 *   AMAZON_LOCATION_SNAPS_PER_MINUTE       safety cap on snapping requests (10–600, default 60)
 *   AMAZON_LOCATION_ETAS_PER_MINUTE        safety cap on arrival-time requests (10–600, default 60)
 *   AMAZON_LOCATION_TRUCK_HEIGHT_CM        truck profile (default 411 cm = 13 ft 6 in)
 *   AMAZON_LOCATION_TRUCK_LENGTH_CM        truck profile (default 2286 cm = 75 ft)
 *   AMAZON_LOCATION_TRUCK_WEIGHT_KG        truck profile (default 36287 kg = 80,000 lb)
 */

type Env = Record<string, string | undefined>;

export type TruckProfile = {
  heightCm: number;
  lengthCm: number;
  grossWeightKg: number;
};

export type AmazonLocationConfig = {
  snapToRoadsEnabled: boolean;
  etaEnabled: boolean;
  region: string;
  travelMode: "Truck" | "Car";
  snapsPerMinute: number;
  etasPerMinute: number;
  truck: TruckProfile;
};

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function getAmazonLocationConfig(env: Env = process.env): AmazonLocationConfig {
  const region = String(env.AMAZON_LOCATION_REGION || env.AWS_REGION || "us-west-2").trim();
  return {
    snapToRoadsEnabled: String(env.AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED ?? "").trim().toLowerCase() === "true",
    etaEnabled: String(env.AMAZON_LOCATION_ETA_ENABLED ?? "").trim().toLowerCase() === "true",
    region: /^[a-z]{2}(-[a-z]+)+-\d$/.test(region) ? region : "us-west-2",
    travelMode: String(env.AMAZON_LOCATION_TRAVEL_MODE ?? "").trim().toLowerCase() === "car" ? "Car" : "Truck",
    snapsPerMinute: bounded(env.AMAZON_LOCATION_SNAPS_PER_MINUTE, 60, 10, 600),
    etasPerMinute: bounded(env.AMAZON_LOCATION_ETAS_PER_MINUTE, 60, 10, 600),
    // A typical US car-hauler (tractor and trailer at the legal limits).
    truck: {
      heightCm: bounded(env.AMAZON_LOCATION_TRUCK_HEIGHT_CM, 411, 200, 500),
      lengthCm: bounded(env.AMAZON_LOCATION_TRUCK_LENGTH_CM, 2286, 600, 3000),
      grossWeightKg: bounded(env.AMAZON_LOCATION_TRUCK_WEIGHT_KG, 36_287, 3_000, 60_000),
    },
  };
}
