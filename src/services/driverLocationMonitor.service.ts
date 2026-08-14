import Load from "../models/Load.model";
import User from "../models/User.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverStatusChangeRequest from "../models/DriverStatusChangeRequest.model";
import Notification from "../models/Notification.model";
import DispatchChatMessage from "../models/DispatchChatMessage.model";
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
  dispatchOwnerId?: any;
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

function getDispatchOwnerId(load: ActiveLoadSnapshot): string | null {
  const value = String(load.dispatchOwnerId ?? "").trim();
  return value || null;
}

function groupLoadsByDispatchOwner(loads: ActiveLoadSnapshot[]) {
  const groups = new Map<string, ActiveLoadSnapshot[]>();
  for (const load of loads) {
    const dispatcherId = getDispatchOwnerId(load);
    if (!dispatcherId) continue;
    const current = groups.get(dispatcherId) ?? [];
    current.push(load);
    groups.set(dispatcherId, current);
  }
  return groups;
}

// Older active loads may predate dispatchOwnerId. Recover ownership only when
// the already-private Dispatch Chat timeline contains explicit dispatcher-
// authored assignment evidence for that exact load + driver. This is safe to
// run in the monitor because it never falls back to "any dispatcher in org".
async function backfillExplicitDispatchOwners(
  loads: ActiveLoadSnapshot[],
): Promise<void> {
  const missing = loads.filter((load) => !getDispatchOwnerId(load));
  if (!missing.length) return;

  const missingById = new Map(
    missing.map((load) => [String(load._id), load]),
  );

  const evidenceRows: any[] = await DispatchChatMessage.find({
    senderRole: "dispatcher",
    messageType: "system",
    "systemEvent.type": {
      $in: ["driver_load_assigned", "driver_load_request_approved"],
    },
    "systemEvent.metadata.loadId": { $in: [...missingById.keys()] },
  })
    .select(
      "organizationId driverId dispatcherId senderId systemEvent.metadata.loadId createdAt",
    )
    .sort({ createdAt: -1 })
    .lean();

  const resolvedLoadIds = new Set<string>();

  for (const evidence of evidenceRows) {
    const loadId = String(evidence?.systemEvent?.metadata?.loadId ?? "").trim();
    if (!loadId || resolvedLoadIds.has(loadId)) continue;

    const load = missingById.get(loadId);
    if (!load) continue;
    if (String(evidence.organizationId) !== String(load.organizationId)) continue;
    if (String(evidence.driverId) !== String(load.assignedDriverId)) continue;

    const dispatcherId = String(
      evidence.dispatcherId ?? evidence.senderId ?? "",
    ).trim();
    if (!dispatcherId) continue;

    // Persist only if another request has not already supplied an owner.
    const result = await Load.updateOne(
      {
        _id: load._id,
        $or: [
          { dispatchOwnerId: null },
          { dispatchOwnerId: { $exists: false } },
        ],
      },
      { $set: { dispatchOwnerId: dispatcherId } },
    );

    if (result.modifiedCount > 0 || result.matchedCount > 0) {
      load.dispatchOwnerId = dispatcherId;
      resolvedLoadIds.add(loadId);
    }
  }
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

async function notifyResponsibleDispatchers(params: {
  organizationId: string;
  driverId: string;
  driverName: string;
  lastSeenAt: Date | null;
  silenceStartedAt: Date;
  driverLoads: ActiveLoadSnapshot[];
}) {
  const {
    organizationId,
    driverId,
    driverName,
    lastSeenAt,
    silenceStartedAt,
    driverLoads,
  } = params;

  const loadsByDispatcher = groupLoadsByDispatchOwner(driverLoads);
  const dispatcherIds = [...loadsByDispatcher.keys()];
  if (!dispatcherIds.length) {
    logger.warn(
      { driverId, loadIds: driverLoads.map((load) => String(load._id)) },
      "[DriverLocationMonitor] GPS alert skipped because no explicit dispatch owner is recorded",
    );
    return;
  }

  // Validate only the explicitly recorded owners. Same-organization membership
  // alone never grants another dispatcher access to this GPS safety alert.
  const dispatchers = await User.find({
    _id: { $in: dispatcherIds },
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
  const silenceIncidentId =
    `driver-location-silence:${driverId}:` +
    `${reference.toISOString()}`;
  const reminderNumber = Math.max(
    1,
    Math.floor(minutesWithoutLocation / 10),
  );
  const incidentId =
    `${silenceIncidentId}:reminder:${reminderNumber}`;

  await Promise.allSettled(
    (dispatchers as any[]).map(async (dispatcher: any) => {
      const dispatcherId = String(dispatcher._id);
      const ownedLoads = loadsByDispatcher.get(dispatcherId) ?? [];
      if (!ownedLoads.length) return;

      const loadNumbers = ownedLoads
        .map((load) => load.loadNumber)
        .filter((value): value is string => Boolean(value));
      const loadIds = ownedLoads.map((load) => String(load._id));
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

      const metadata = {
        incidentId,
        silenceIncidentId,
        reminderNumber,
        dispatcherId,
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

      const notification = await createGuaranteedDispatchNotification({
        dispatcherId,
        organizationId,
        title,
        message,
        metadata,
        incidentId,
      });

      // Realtime safety alert content is private too. Do not emit this event to
      // the organization room; only the dispatcher who owns these load(s) gets it.
      if (notification) {
        emitToUser(dispatcherId, "driver:location_offline_alert", {
          type: "driver_tracker_offline_alert",
          title,
          message,
          metadata,
          driverId,
          driverName,
          createdAt: now.toISOString(),
        });
      }
    }),
  );
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
        "_id organizationId assignedDriverId dispatchOwnerId loadNumber status assignedAt createdAt updatedAt",
      )
      .lean()) as ActiveLoadSnapshot[];

    if (!activeLoads.length) return;

    // Privacy-safe compatibility for already-active loads created before this
    // ownership field existed. Explicit private assignment history is enough;
    // ambiguous legacy loads remain un-routed rather than leaking an alert.
    await backfillExplicitDispatchOwners(activeLoads);

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

    const [drivers, locations, profiles, emergencyRequests, retainedGpsRequests] = await Promise.all([
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
          "_id userId organizationId status coords lastSeenAt isSharing offlineAlertSentAt",
        )
        .lean(),

      DriverProfile.find({ userId: { $in: driverIds } })
        .select("userId operationalStatus")
        .lean(),

      DriverStatusChangeRequest.find({
        driverId: { $in: driverIds },
        priority: "emergency",
        status: { $in: ["pending", "approved_awaiting_reassignment"] },
      })
        .select("driverId priority status")
        .lean(),

      // Completed/transitioning Keep Assigned decisions are durable GPS-policy
      // records. Fetch them in one batch so the monitor does not issue N+1
      // policy queries for On Leave / In Shop drivers.
      DriverStatusChangeRequest.find({
        driverId: { $in: driverIds },
        requestedStatus: { $in: ["on_leave", "maintenance"] },
        status: { $in: ["approved_awaiting_reassignment", "completed"] },
        loadHandlingDecision: "keep_assigned",
      })
        .select(
          "driverId requestedStatus affectedLoadIds retainedGpsRequired reviewedAt completedAt createdAt",
        )
        .sort({ reviewedAt: -1, completedAt: -1, createdAt: -1 })
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
    const profileByDriver = new Map(
      (profiles as any[]).map((profile) => [String(profile.userId), profile]),
    );
    const emergencyDriverIds = new Set(
      (emergencyRequests as any[]).map((request) => String(request.driverId)),
    );
    const retainedPoliciesByDriver = new Map<string, any[]>();
    for (const policy of retainedGpsRequests as any[]) {
      const key = String(policy.driverId);
      const current = retainedPoliciesByDriver.get(key) ?? [];
      current.push(policy);
      retainedPoliciesByDriver.set(key, current);
    }

    for (const [driverId, driverLoads] of loadsByDriver.entries()) {
      const driver: any = driverById.get(driverId);
      if (!driver) continue;

      const profile: any = profileByDriver.get(driverId) ?? null;
      const operationalStatus = profile?.operationalStatus ?? "active";

      const qualifyingLoadIds = new Set(
        driverLoads.map((load) => String(load._id)),
      );
      const retainedPolicy =
        operationalStatus === "active"
          ? null
          : (retainedPoliciesByDriver.get(driverId) ?? []).find(
              (policy: any) =>
                policy.requestedStatus === operationalStatus &&
                (policy.affectedLoadIds ?? []).some((loadId: any) =>
                  qualifyingLoadIds.has(String(loadId)),
                ),
            ) ?? null;
      const dispatchRequiresRetainedGps =
        Boolean(retainedPolicy) && retainedPolicy.retainedGpsRequired === true;

      // Off-duty statuses remain exempt unless Dispatch explicitly kept one of
      // these qualifying loads assigned and required GPS for it.
      if (
        operationalStatus !== "active" &&
        !dispatchRequiresRetainedGps
      ) {
        continue;
      }

      // Emergency release is safety-first: keep GPS if it is available, but
      // suppress ordinary 10-minute compliance-style reminders while Dispatch
      // is already handling the emergency and affected loads.
      if (emergencyDriverIds.has(driverId)) continue;

      const organizationId = String(driver.organizationId);
      const location: any = locationByDriver.get(driverId) ?? null;

      // GPS safety alerts are tied to explicit dispatcher ownership. A legacy
      // load with no owner is never guessed into another dispatcher's alerts.
      const ownedDriverLoads = driverLoads.filter((load) =>
        Boolean(getDispatchOwnerId(load)),
      );
      if (!ownedDriverLoads.length) continue;

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
              isSharing: false,
              offlineAlertSentAt: now,
            },
          },
          { new: true },
        );

        if (!claimed) continue;

        await notifyResponsibleDispatchers({
          organizationId,
          driverId,
          driverName: driver.name || "Driver",
          lastSeenAt,
          silenceStartedAt: lastSeenAt,
          driverLoads: ownedDriverLoads,
        });

        // Keep the open Driver Tracker map/list synchronized immediately.
        emitToOrg(organizationId, "driver:location", {
          driverId,
          coords: claimed.coords ?? null,
          status: "offline",
          isSharing: false,
          lastSeenAt: claimed.lastSeenAt,
        });

        continue;
      }

      // A driver may reach a notification-eligible load status before ever
      // publishing their first GPS heartbeat. In that case the qualifying load's
      // recorded tracking start is used for the 10-minute requirement window.
      const silenceStartedAt = ownedDriverLoads
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

      const ownerIds = [...groupLoadsByDispatchOwner(ownedDriverLoads).keys()];
      const alreadyAlertedOwnerIds = new Set(
        (await Notification.distinct("userId", {
          organizationId,
          type: "driver_tracker_offline_alert",
          userId: { $in: ownerIds },
          "metadata.incidentId": incidentId,
        })).map((id: any) => String(id)),
      );

      const loadsNeedingAlert = ownedDriverLoads.filter((load) => {
        const ownerId = getDispatchOwnerId(load);
        return Boolean(ownerId && !alreadyAlertedOwnerIds.has(ownerId));
      });

      if (!loadsNeedingAlert.length) continue;

      await notifyResponsibleDispatchers({
        organizationId,
        driverId,
        driverName: driver.name || "Driver",
        lastSeenAt: null,
        silenceStartedAt,
        driverLoads: loadsNeedingAlert,
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