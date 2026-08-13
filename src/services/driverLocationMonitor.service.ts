import Load from "../models/Load.model";
import User from "../models/User.model";
import DriverLocation from "../models/DriverLocation.model";
import Notification from "../models/Notification.model";
import notificationService from "./notification.service";
import { emitToOrg, emitToUser } from "../utils/socketEmitter";
import logger from "../utils/logger";

const LOCATION_SILENCE_MS = 10 * 60 * 1000;
const MONITOR_INTERVAL_MS = 60 * 1000;
const ALERT_REPEAT_MS = 10 * 60 * 1000;

// Dispatcher GPS-silence notifications begin only after the driver has
// accepted the load. "Assigned" remains an active-load status elsewhere in
// the Driver Tracker/GPS gate; it is intentionally excluded only from this
// 10-minute notification monitor.
const GPS_ALERT_LOAD_STATUSES = [
  "Accepted",
  "Picked Up",
  "In-Transit",
];

const DISPATCH_ROLES = ["employee", "admin", "super_admin"];

let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;

type ActiveLoadSnapshot = {
  _id: any;
  organizationId: string;
  assignedDriverId: any;
  loadNumber?: string;
  status?: string;
  assignedAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

function getLoadTrackingStart(load: ActiveLoadSnapshot): Date {
  return new Date(
    load.assignedAt ??
      load.updatedAt ??
      load.createdAt ??
      new Date(),
  );
}

async function createGuaranteedDispatchNotification(params: {
  dispatcherId: string;
  organizationId: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  incidentId: string;
}) {
  const {
    dispatcherId,
    organizationId,
    title,
    message,
    metadata,
    incidentId,
  } = params;

  // Use the normal notification service first so the existing socket/push
  // pipeline remains intact.
  const notification = await notificationService.createNotification({
    userId: dispatcherId,
    organizationId,
    type: "driver_tracker_offline_alert",
    title,
    message,
    metadata,
    dedupeKey: `driver-location-silence:${dispatcherId}:${incidentId}`,
    groupWindowMinutes: 24 * 60,
  });

  if (notification) return notification;

  // A location-silence warning for an active load is safety/operations
  // information. Even if the recipient muted Driver Tracker pushes, preserve
  // an in-app notification so Dispatch is not silently unaware.
  const fallback: any = await Notification.create({
    userId: dispatcherId,
    organizationId,
    type: "driver_tracker_offline_alert",
    category: "driverTracker",
    title,
    message,
    metadata,
    isRead: false,
    dedupeKey: `driver-location-silence:${dispatcherId}:${incidentId}`,
    occurrenceCount: 1,
    lastOccurredAt: new Date(),
  });

  emitToUser(dispatcherId, "notification:new", fallback);
  return fallback;
}

async function notifyDispatchers(params: {
  organizationId: string;
  driverId: string;
  driverName: string;
  lastSeenAt: Date | null;
  silenceStartedAt: Date;
  loadNumbers: string[];
  loadIds: string[];
}) {
  const {
    organizationId,
    driverId,
    driverName,
    lastSeenAt,
    silenceStartedAt,
    loadNumbers,
    loadIds,
  } = params;

  const dispatchers = await User.find({
    organizationId,
    role: { $in: DISPATCH_ROLES },
    isActive: true,
  })
    .select("_id name role")
    .lean();

  if (!dispatchers.length) return;

  const now = new Date();
  const reference = lastSeenAt ?? silenceStartedAt;
  const minutesWithoutLocation = Math.max(
    10,
    Math.floor((now.getTime() - reference.getTime()) / 60_000),
  );

  const loadLabel =
    loadNumbers.length === 1
      ? `load ${loadNumbers[0]}`
      : loadNumbers.length > 1
        ? `${loadNumbers.length} active loads (${loadNumbers.join(", ")})`
        : "an active load";

  const title = "Driver Is Not Sharing Location";
  const message =
    `${driverName} has not shared a GPS location for ` +
    `${minutesWithoutLocation} minutes while assigned to ${loadLabel}.`;

  const silenceIncidentId =
    `driver-location-silence:${driverId}:` +
    `${reference.toISOString()}`;
  const reminderNumber = Math.max(
    1,
    Math.floor(minutesWithoutLocation / 10),
  );
  const incidentId =
    `${silenceIncidentId}:reminder:${reminderNumber}`;

  const metadata = {
    incidentId,
    silenceIncidentId,
    reminderNumber,
    driverId,
    driverName,
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    silenceStartedAt: reference.toISOString(),
    minutesWithoutLocation,
    silenceThresholdMinutes: 10,
    loadIds,
    loadNumbers,
    route:
      `/driver-tracker?driverId=${encodeURIComponent(driverId)}` +
      "&openDispatchChat=1",
    pushSource: "Driver Tracker",
    requiresAttention: true,
  };

  await Promise.allSettled(
    dispatchers.map((dispatcher: any) =>
      createGuaranteedDispatchNotification({
        dispatcherId: String(dispatcher._id),
        organizationId,
        title,
        message,
        metadata,
        incidentId,
      }),
    ),
  );

  // Also update currently-open Driver Tracker clients immediately.
  emitToOrg(organizationId, "driver:location_offline_alert", {
    type: "driver_tracker_offline_alert",
    title,
    message,
    metadata,
    driverId,
    driverName,
    createdAt: now.toISOString(),
  });
}

async function monitorDriverLocationSilence() {
  if (monitorRunning) return;
  monitorRunning = true;

  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - LOCATION_SILENCE_MS);
    const repeatCutoff = new Date(now.getTime() - ALERT_REPEAT_MS);

    // Only drivers whose loads have moved beyond Assigned are monitored for
    // 10-minute GPS-silence notifications. Assigned loads remain active for the
    // Driver Portal GPS gate, but do not notify Dispatch until the driver accepts.
    // Drivers with no qualifying load are intentionally ignored here.
    const activeLoads = (await Load.find({
      assignedDriverId: { $ne: null },
      status: { $in: GPS_ALERT_LOAD_STATUSES },
    })
      .select(
        "_id organizationId assignedDriverId loadNumber status assignedAt createdAt updatedAt",
      )
      .lean()) as ActiveLoadSnapshot[];

    if (!activeLoads.length) return;

    const loadsByDriver = new Map<string, ActiveLoadSnapshot[]>();

    for (const load of activeLoads) {
      if (!load.assignedDriverId || !load.organizationId) continue;
      const driverId = String(load.assignedDriverId);
      const current = loadsByDriver.get(driverId) ?? [];
      current.push(load);
      loadsByDriver.set(driverId, current);
    }

    const driverIds = [...loadsByDriver.keys()];
    if (!driverIds.length) return;

    const [drivers, locations] = await Promise.all([
      User.find({
        _id: { $in: driverIds },
        role: "driver",
        isActive: true,
      })
        .select("_id name organizationId")
        .lean(),

      DriverLocation.find({
        userId: { $in: driverIds },
      })
        .select(
          "_id userId organizationId status coords lastSeenAt offlineAlertSentAt",
        )
        .lean(),
    ]);

    const driverById = new Map(
      (drivers as any[]).map((driver) => [
        String(driver._id),
        driver,
      ]),
    );

    const locationByDriver = new Map(
      (locations as any[]).map((location) => [
        String(location.userId),
        location,
      ]),
    );

    for (const [driverId, driverLoads] of loadsByDriver.entries()) {
      const driver: any = driverById.get(driverId);
      if (!driver) continue;

      const organizationId = String(driver.organizationId);
      const location: any = locationByDriver.get(driverId) ?? null;

      const loadNumbers = driverLoads
        .map((load) => load.loadNumber)
        .filter((value): value is string => Boolean(value));

      const loadIds = driverLoads.map((load) => String(load._id));

      // If the driver has shared at least once, lastSeenAt is authoritative.
      if (location?.lastSeenAt) {
        const lastSeenAt = new Date(location.lastSeenAt);
        if (lastSeenAt > cutoff) continue;

        // Atomically claim this stale incident so parallel server instances or
        // overlapping monitor runs cannot notify Dispatch twice.
        const claimed: any = await DriverLocation.findOneAndUpdate(
          {
            _id: location._id,
            lastSeenAt: { $lte: cutoff },
            $or: [
              { offlineAlertSentAt: null },
              { offlineAlertSentAt: { $exists: false } },
              { offlineAlertSentAt: { $lte: repeatCutoff } },
            ],
          },
          {
            $set: {
              status: "offline",
              offlineAlertSentAt: now,
            },
          },
          { new: true },
        );

        if (!claimed) continue;

        await notifyDispatchers({
          organizationId,
          driverId,
          driverName: driver.name || "Driver",
          lastSeenAt,
          silenceStartedAt: lastSeenAt,
          loadNumbers,
          loadIds,
        });

        // Keep the open Driver Tracker map/list synchronized immediately.
        emitToOrg(organizationId, "driver:location", {
          driverId,
          coords: claimed.coords ?? null,
          status: "offline",
          lastSeenAt: claimed.lastSeenAt,
        });

        continue;
      }

      // A driver may reach a notification-eligible load status before ever
      // publishing their first GPS heartbeat. In that case the qualifying load's
      // recorded tracking start is used for the 10-minute requirement window.
      const silenceStartedAt = driverLoads
        .map(getLoadTrackingStart)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      if (
        !silenceStartedAt ||
        now.getTime() - silenceStartedAt.getTime() <
          LOCATION_SILENCE_MS
      ) {
        continue;
      }

      // No DriverLocation row exists yet, so use the persisted notification
      // incident marker to avoid re-alerting every monitor minute.
      const minutesWithoutLocation = Math.max(
        10,
        Math.floor(
          (now.getTime() - silenceStartedAt.getTime()) /
            60_000,
        ),
      );
      const reminderNumber = Math.max(
        1,
        Math.floor(minutesWithoutLocation / 10),
      );
      const silenceIncidentId =
        `driver-location-silence:${driverId}:` +
        `${silenceStartedAt.toISOString()}`;
      const incidentId =
        `${silenceIncidentId}:reminder:${reminderNumber}`;

      const alreadyAlerted = await Notification.exists({
        organizationId,
        type: "driver_tracker_offline_alert",
        "metadata.incidentId": incidentId,
      });

      if (alreadyAlerted) continue;

      await notifyDispatchers({
        organizationId,
        driverId,
        driverName: driver.name || "Driver",
        lastSeenAt: null,
        silenceStartedAt,
        loadNumbers,
        loadIds,
      });

      emitToOrg(organizationId, "driver:location_offline_alert", {
        type: "driver_tracker_offline_alert",
        title: "Driver Is Not Sharing Location",
        message:
          `${driver.name || "Driver"} has not started GPS location sharing ` +
          "within 10 minutes of receiving an active load.",
        metadata: {
          incidentId,
          silenceIncidentId,
          reminderNumber,
          driverId,
          driverName: driver.name || "Driver",
          lastSeenAt: null,
          silenceStartedAt: silenceStartedAt.toISOString(),
          silenceThresholdMinutes: 10,
          loadIds,
          loadNumbers,
          route:
      `/driver-tracker?driverId=${encodeURIComponent(driverId)}` +
      "&openDispatchChat=1",
          requiresAttention: true,
        },
        driverId,
        driverName: driver.name || "Driver",
        createdAt: now.toISOString(),
      });
    }
  } catch (error) {
    logger.error(
      { error },
      "[DriverLocationMonitor] Failed to check driver location silence",
    );
  } finally {
    monitorRunning = false;
  }
}

export function startDriverLocationMonitor() {
  if (monitorTimer) return;

  // Check every minute. First alert occurs after 10 minutes of GPS silence;
  // while the active-load driver remains offline, another reminder becomes
  // eligible every additional 10 minutes.
  const startupTimer = setTimeout(() => {
    void monitorDriverLocationSilence();
  }, 15_000);
  startupTimer.unref?.();

  monitorTimer = setInterval(() => {
    void monitorDriverLocationSilence();
  }, MONITOR_INTERVAL_MS);

  monitorTimer.unref?.();

  logger.info(
    {
      silenceThresholdMinutes: LOCATION_SILENCE_MS / 60_000,
      monitorIntervalSeconds: MONITOR_INTERVAL_MS / 1000,
    },
    "[DriverLocationMonitor] Started",
  );
}

export function stopDriverLocationMonitor() {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
}

export { monitorDriverLocationSilence };