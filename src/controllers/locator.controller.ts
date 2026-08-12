import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import Place from '../models/Place.model';
import PlaceVisit from '../models/PlaceVisit.model';
import PresenceEvent from '../models/PresenceEvent.model';
import LocationHistory from '../models/LocationHistory.model';
import DrivingSession from '../models/DrivingSession.model';
import SosAlert from '../models/SosAlert.model';
import { emitToOrg } from '../utils/socketEmitter';
import { distanceMeters } from '../utils/geofence';
import { isMobileMonitoringDept, isLocationRequiredForUser } from '../config/departmentMonitoring';
import { getCompanyDayRange } from '../utils/companyTimezone';
import { isMandatoryLocationDept } from '../constants/departments';
import { getShiftStatusForActor } from '../utils/shiftStatus';
import { fireShiftAlert } from '../services/shiftAlerts.service';
import notificationService from '../services/notification.service';
import { invalidateUserCache } from '../utils/cache.util';

const HISTORY_THROTTLE_MS = 30_000;
const HARSH_BRAKING_DROP_MPH = 15;
const INCIDENT_PRIOR_SPEED_MPH = 25;
const INCIDENT_STOP_SPEED_MPH = 3;
const METERS_TO_MILES = 0.000621371;
const SPEEDING_THRESHOLD_MPH = 80;
const STATIONARY_RADIUS_M = 40;
const LOT_TECH_STATIONARY_THRESHOLD_MS = 45 * 60 * 1000;
const LOT_TECH_OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;
const STATIONARY_LOG_MIN_MINUTES = 10;
// Sharing loop pings every 30s (see useLocationSharing.ts) — 10 min is generous slack for
// mobile backgrounding before we treat a "sharing" row as abandoned (app killed/uninstalled)
// rather than live.
const SHARING_STALE_MS = 10 * 60 * 1000;

type LocatorActor = {
    doc: IUser | ICrmUser;
    model: 'User' | 'CrmUser';
    id: any;
    name: string;
    email?: string;
    avatar?: string | null;
    organizationId?: any;
    role?: string;
    department?: string;
    jobTitle?: string;
    locationConsent?: { granted?: boolean; grantedAt?: Date; deviceHint?: string };
    locationSharingOptOut?: boolean;
    locationRequiredOverride?: 'default' | 'required' | 'exempt';
};

function getLocatorActor(req: Request): LocatorActor {
    const crmUser = req.crmUser as ICrmUser | undefined;
    const mainUser = req.user as IUser | undefined;
    const doc = mainUser || crmUser;
    if (!doc) throw new ApiError(401, 'Not authenticated');

    const isCrm = !mainUser && !!crmUser;
    const anyDoc = doc as any;
    return {
        doc,
        model: isCrm ? 'CrmUser' : 'User',
        id: anyDoc._id,
        name: anyDoc.name || anyDoc.fullName || anyDoc.email || 'Team member',
        email: anyDoc.email,
        avatar: anyDoc.avatar,
        organizationId: anyDoc.organizationId,
        role: anyDoc.role,
        department: anyDoc.department ?? anyDoc.personalInfo?.department,
        jobTitle: anyDoc.personalInfo?.jobTitle,
        locationConsent: anyDoc.locationConsent,
        locationSharingOptOut: !!anyDoc.locationSharingOptOut,
        locationRequiredOverride: anyDoc.locationRequiredOverride,
    };
}

function actorSnapshot(actor: LocatorActor) {
    return {
        userName: actor.name,
        userAvatar: actor.avatar,
        jobTitle: actor.jobTitle,
        department: actor.department,
    };
}

// A physical person can have both a main-site `User` account and a separate `CrmUser`
// account (see getActiveEmployeeLocations' dedup comment) with no persisted link between
// them — only email in common. Without this, turning sharing on/off on one account leaves
// the other's `locationConsent` untouched, so the person can appear to be sharing on one
// surface and not the other. Mirrors the on/off switch (and its EmployeeLocation row) onto
// whichever linked account matches by email, best-effort — never blocks the primary update.
async function syncLinkedAccountConsent(actor: LocatorActor, granted: boolean, deviceHint?: string) {
    if (!actor.email) return;
    try {
        const email = actor.email.toLowerCase();
        const linked = actor.model === 'User'
            ? await CrmUser.findOne({ email, organizationId: actor.organizationId })
            : await User.findOne({ email, organizationId: actor.organizationId });
        if (!linked) return;

        const linkedUpdate = { locationConsent: { granted, grantedAt: new Date(), deviceHint } };
        if (actor.model === 'User') {
            await CrmUser.findByIdAndUpdate(linked._id, linkedUpdate);
        } else {
            await User.findByIdAndUpdate(linked._id, linkedUpdate);
            invalidateUserCache((linked._id as any).toString());
        }

        if (!granted) {
            await EmployeeLocation.findOneAndUpdate(
                { userId: linked._id },
                { sharingState: 'off_duty', $unset: { currentPlaceId: '' } },
            );
            emitToOrg(actor.organizationId, 'locator:sharing_state_changed', {
                userId: (linked._id as any).toString(),
                sharingState: 'off_duty',
            });
        }
    } catch {
        // Best-effort — the primary account's own consent update already succeeded.
    }
}

/**
 * Called whenever a user's location sharing transitions from ON to OFF
 * (whether via the consent toggle or the opt-out toggle — both funnel here).
 * If they're actively on shift and NOT on break, this warns them and admins
 * via the Shift Alerts channel — it deliberately does NOT end their shift
 * anymore; turning location off mid-shift is a sanctioned action (TimeProof's
 * own "Stop Sharing" flow), just one that both sides should know happened.
 * Turning off location WHILE on break is expected/private and stays exempt.
 */
async function handleLocationTurnedOff(actor: LocatorActor, orgId: string): Promise<void> {
    if (!orgId) return;
    if (!(await isLocationRequiredForUser(orgId, actor.department, actor.locationRequiredOverride))) return;
    const { isOnShift, isOnBreak } = await getShiftStatusForActor(actor.id);
    if (!isOnShift || isOnBreak) return;

    await fireShiftAlert({
        organizationId: orgId,
        targetUserId: actor.id.toString(),
        targetUserModel: actor.model,
        chatMessage: `🟡 ${actor.name} turned off location sharing during their active shift.`,
        notifyTitle: '📍 Location Sharing Paused',
        notifyBody: `${actor.name} turned off location sharing during their active shift.`,
        notifyTag: `shift-alert-location-off-${actor.id}`,
        url: `/crm/timeproof/users/${actor.id}`,
    });
}

/**
 * Departments flagged `isMandatoryLocationDept` (currently only Lot Tech) may not turn
 * their own location sharing off while actively clocked in — boss-level policy, not a
 * privacy trade-off made lightly (see the earlier "rights violation" removal of a similar
 * blanket lock in the Beacon UI). Scoped narrowly: only blocks while on shift and not on
 * break, and never blocks the automatic break-pause (`reason === 'break'`) — a Lot Tech can
 * still always end this by clocking out, which is the sanctioned exit.
 */
async function assertCanTurnOffLocation(actor: LocatorActor, orgId: string | undefined, opts?: { isBreakPause?: boolean }): Promise<void> {
    if (opts?.isBreakPause) return;
    if (!orgId) return;
    if (!(await isMandatoryLocationDept(orgId, actor.department))) return;
    const { isOnShift, isOnBreak } = await getShiftStatusForActor(actor.id);
    if (!isOnShift || isOnBreak) return;
    throw new ApiError(403, 'Lot Tech accounts cannot turn off location sharing while clocked in. End your shift to stop sharing.');
}

async function updateActorLocationConsent(actor: LocatorActor, granted: boolean, deviceHint?: string) {
    const update = { locationConsent: { granted, grantedAt: new Date(), deviceHint } };
    if (actor.model === 'CrmUser') {
        await CrmUser.findByIdAndUpdate(actor.id, update);
    } else {
        await User.findByIdAndUpdate(actor.id, update);
        invalidateUserCache(actor.id.toString());
    }
    await syncLinkedAccountConsent(actor, granted, deviceHint);
}

export async function startDrivingSessionForAppointment(
    orgId: string,
    appointmentId: string,
    userId: string,
    userName: string,
    vehicleId?: string,
) {
    const existing = await DrivingSession.findOne({ appointmentId, status: 'active' });
    if (existing) return existing;

    const session = await DrivingSession.create({
        organizationId: orgId,
        userId, userName, appointmentId, vehicleId,
        startedAt: new Date(),
        status: 'active',
    });

    await EmployeeLocation.findOneAndUpdate({ userId }, { organizationId: orgId, drivingSessionId: session._id });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId, userName,
        type: 'driving_session_start',
        description: `${userName} started a test drive`,
        meta: { sessionId: session._id, appointmentId },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:driving_session_start', { sessionId: session._id, userId, appointmentId });

    return session;
}

export async function endDrivingSessionForAppointment(appointmentId: string) {
    const session = await DrivingSession.findOne({ appointmentId, status: 'active' });
    if (!session) return null;

    session.status = 'completed';
    session.endedAt = new Date();
    await session.save();

    await EmployeeLocation.findOneAndUpdate({ userId: session.userId }, { $unset: { drivingSessionId: '' } });

    const event = await PresenceEvent.create({
        organizationId: session.organizationId,
        userId: session.userId,
        userName: session.userName,
        type: 'driving_session_end',
        description: `${session.userName} finished a test drive — top speed ${Math.round(session.topSpeedMph)} mph`,
        meta: { sessionId: session._id, appointmentId, topSpeedMph: session.topSpeedMph, distanceMi: session.distanceMi },
    });
    emitToOrg(session.organizationId.toString(), 'activity:new', event);
    emitToOrg(session.organizationId.toString(), 'locator:driving_session_end', { sessionId: session._id, userId: session.userId.toString(), appointmentId });

    return session;
}

async function updateDrivingTelematics(
    orgId: string,
    sessionId: any,
    user: IUser,
    lat: number,
    lng: number,
    speedMph: number | undefined,
) {
    const session = await DrivingSession.findById(sessionId);
    if (!session || session.status !== 'active') return;

    if (typeof speedMph === 'number') {
        if (speedMph > session.topSpeedMph) session.topSpeedMph = speedMph;

        if (typeof session.lastSpeedMph === 'number' && session.lastSpeedMph - speedMph >= HARSH_BRAKING_DROP_MPH) {
            session.harshBrakingEvents += 1;
        }

        const wasSpeeding = typeof session.lastSpeedMph === 'number' && session.lastSpeedMph >= SPEEDING_THRESHOLD_MPH;
        if (speedMph >= SPEEDING_THRESHOLD_MPH && !wasSpeeding) {
            session.speedingEvents += 1;
        }

        if (
            !session.possibleIncident &&
            typeof session.lastSpeedMph === 'number' &&
            session.lastSpeedMph >= INCIDENT_PRIOR_SPEED_MPH &&
            speedMph <= INCIDENT_STOP_SPEED_MPH
        ) {
            session.possibleIncident = { detectedAt: new Date(), speedBeforeMph: session.lastSpeedMph };

            const event = await PresenceEvent.create({
                organizationId: orgId,
                userId: user._id,
                userName: user.name,
                type: 'possible_incident',
                description: `Possible incident detected during ${user.name}'s test drive`,
                meta: { sessionId: session._id, speedBeforeMph: session.lastSpeedMph },
            });
            emitToOrg(orgId, 'activity:new', event);
            emitToOrg(orgId, 'locator:possible_incident', {
                sessionId: session._id, userId: user._id.toString(), userName: user.name,
                coords: { lat, lng }, detectedAt: session.possibleIncident.detectedAt,
            });
            notifyAdmins(orgId, {
                title: '⚠️ Possible Incident',
                body: `${user.name} may have been in an incident during a test drive`,
                tag: `locator-incident-${session._id}`,
                data: { url: '/team-pulse?tab=activity' },
            });
        }

        session.lastSpeedMph = speedMph;
    }

    if (session.startedAt) {
        const lastPoint = await LocationHistory.findOne({ drivingSessionId: session._id }).sort({ recordedAt: -1 }).lean();
        if (lastPoint) {
            const meters = distanceMeters(lastPoint.coords.lat, lastPoint.coords.lng, lat, lng);
            session.distanceMi += meters * METERS_TO_MILES;
        }
    }

    await session.save();
}

// Lot-tech geofence alerts are CRM-internal (Team Pulse activity, CrmUser
// admins/managers only) — routed through the unified notification service so
// they persist to the bell/page (not just an ephemeral push, which used to
// silently no-op for main-User admins whenever Redis was disabled).
async function notifyAdmins(
    orgId: string,
    payload: { title: string; body: string; tag?: string; data?: Record<string, any> },
    dedupeSubjectId?: string,
) {
    try {
        const admins = await CrmUser.find({ organizationId: orgId, role: { $in: ['admin', 'manager'] }, isActive: true })
            .select('_id')
            .lean();
        await Promise.allSettled(
            admins.map((admin) =>
                notificationService.createNotification({
                    userId: admin._id.toString(),
                    organizationId: orgId,
                    type: 'driver_tracker_geofence_alert',
                    title: payload.title,
                    message: payload.body,
                    metadata: { route: payload.data?.url || '/team-pulse?tab=activity', ...payload.data },
                    // Repeat enter/exit transitions for the SAME employee within the
                    // window compile into one evolving notification instead of one
                    // alert per transition — scoped by dedupeSubjectId (the employee),
                    // never just admin+type, so different employees never merge.
                    ...(dedupeSubjectId ? {
                        dedupeKey: `geofence:${admin._id}:${dedupeSubjectId}`,
                        groupWindowMinutes: 20,
                    } : {}),
                })
            ),
        );
    } catch {
        // Best-effort — never let an alert failure break the location update flow.
    }
}

// A GPS fix worse than this (WiFi/cell-tower fallback, common indoors at a
// dealership) is too coarse to trust for geofence math — used purely to gate
// place-transition detection, never to hide/distort the live map dot itself.
const GEOFENCE_ACCURACY_THRESHOLD_M = 100;
// A fix worse than this isn't just unreliable for geofencing — it's unreliable to PLOT at
// all (this is WiFi/cell-tower positioning territory, hundreds of meters off, not GPS noise).
// Ingesting it as the person's coords/history point would visibly teleport their pin to a
// wrong spot on the map — worse than just holding their last known good position, which is
// what every consumer location-sharing app (Life360, Find My) does during a signal gap.
const POSITION_ACCURACY_REJECT_M = 300;
// Extra slack applied only when checking whether someone is STILL inside their
// current place — without this, ordinary GPS jitter right at a fence's edge
// flips enter/exit back and forth on consecutive pings ("flapping"). Entering
// a NEW place still requires being inside its plain radiusM, no buffer.
const GEOFENCE_EXIT_BUFFER_M = 20;

/**
 * Resolves which Place (if any) a fresh fix puts someone inside, with
 * hysteresis: if they already have a current place, they only count as having
 * left it once they're outside radiusM + GEOFENCE_EXIT_BUFFER_M, not the
 * instant a noisy ping lands a few meters past the raw edge. A place with its
 * own admin-configured warningRadiusM (must be > radiusM) uses THAT as the
 * exit threshold instead of the fixed 20m buffer — a deliberately wider
 * "still nearby, don't count it as left yet" zone for places where a small
 * step outside shouldn't read the same as genuinely leaving.
 */
async function resolveCurrentPlace(orgId: string, lat: number, lng: number, currentPlaceId?: string | null) {
    const places = await Place.find({ organizationId: orgId, isActive: true }).lean();

    if (currentPlaceId) {
        const current = places.find((p) => p._id.toString() === currentPlaceId.toString());
        if (current) {
            const exitThreshold = current.warningRadiusM && current.warningRadiusM > current.radiusM
                ? current.warningRadiusM
                : current.radiusM + GEOFENCE_EXIT_BUFFER_M;
            if (distanceMeters(lat, lng, current.coords.lat, current.coords.lng) <= exitThreshold) {
                return current;
            }
        }
    }

    for (const place of places) {
        const distance = distanceMeters(lat, lng, place.coords.lat, place.coords.lng);
        if (distance <= place.radiusM) return place;
    }
    return null;
}

// Self-notify (the person who left/arrived, not the admin) — persisted and
// grouped just like the admin side, so the employee gets their own
// arrival/departure history instead of an ephemeral, unrecorded push, and
// rapid in/out/in doesn't spam them with a fresh notification per transition.
function notifyActor(
    orgId: string,
    actor: { id: any },
    payload: { title: string; body: string; tag: string; data?: Record<string, any> },
) {
    notificationService.createNotification({
        userId: actor.id.toString(),
        organizationId: orgId,
        type: 'driver_tracker_geofence_alert',
        title: payload.title,
        message: payload.body,
        metadata: { route: payload.data?.url || '/team-pulse?tab=activity', selfNotify: true, ...payload.data },
        dedupeKey: `geofence-self:${actor.id}`,
        groupWindowMinutes: 20,
    }).catch(() => {});
}

async function handleGeofenceTransition(
    orgId: string,
    actor: LocatorActor,
    previousPlaceId: string | undefined | null,
    nextPlace: { _id: any; name: string } | null,
) {
    const user = { _id: actor.id, name: actor.name, avatar: actor.avatar };
    const prevId = previousPlaceId ? previousPlaceId.toString() : null;
    const nextId = nextPlace ? nextPlace._id.toString() : null;
    if (prevId === nextId) return;

    if (prevId) {
        const visit = await PlaceVisit.findOne({ userId: user._id, placeId: prevId, exitedAt: { $exists: false } }).sort({ enteredAt: -1 });
        if (visit) {
            visit.exitedAt = new Date();
            visit.durationMin = Math.round((visit.exitedAt.getTime() - visit.enteredAt.getTime()) / 60000);
            await visit.save();

            const event = await PresenceEvent.create({
                organizationId: orgId,
                userId: user._id,
                userName: user.name,
                userAvatar: user.avatar,
                type: 'geofence_exit',
                description: `${user.name} left ${visit.placeName}`,
                meta: { placeId: visit.placeId, placeName: visit.placeName, durationMin: visit.durationMin },
            });
            emitToOrg(orgId, 'activity:new', event);
            emitToOrg(orgId, 'locator:place_exited', {
                userId: user._id.toString(), userName: user.name,
                placeId: visit.placeId, placeName: visit.placeName,
                exitedAt: visit.exitedAt, durationMin: visit.durationMin,
            });
            notifyActor(orgId, actor, {
                title: '⚠️ You left the area',
                body: `You left ${visit.placeName}. Admins have been notified.`,
                tag: `locator-exit-self-${actor.id}`,
                data: { url: '/team-pulse?tab=activity' },
            });
            // Widened from Lot-Tech-only to every department — admins asked to be able to
            // monitor anyone's office-radius activity, not just the mobile-monitoring dept.
            notifyAdmins(orgId, {
                title: '🚨 Left Premises',
                body: `${user.name} left ${visit.placeName}`,
                tag: `geofence-exit-${user._id}`,
                data: { url: '/team-pulse?tab=activity' },
            }, user._id.toString());
        }
    }

    if (nextPlace) {
        const visit = await PlaceVisit.create({
            organizationId: orgId,
            userId: user._id,
            userName: user.name,
            placeId: nextPlace._id,
            placeName: nextPlace.name,
            enteredAt: new Date(),
            method: 'auto',
        });

        const event = await PresenceEvent.create({
            organizationId: orgId,
            userId: user._id,
            userName: user.name,
            userAvatar: user.avatar,
            type: 'geofence_enter',
            description: `${user.name} arrived at ${nextPlace.name}`,
            meta: { placeId: nextPlace._id, placeName: nextPlace.name },
        });
        emitToOrg(orgId, 'activity:new', event);
        emitToOrg(orgId, 'locator:place_entered', {
            userId: user._id.toString(), userName: user.name,
            placeId: nextPlace._id, placeName: nextPlace.name, enteredAt: visit.enteredAt,
        });
        notifyActor(orgId, actor, {
            title: '📍 Arrived',
            body: `You're now at ${nextPlace.name}.`,
            tag: `locator-arrival-self-${actor.id}`,
            data: { url: '/team-pulse?tab=activity' },
        });
        notifyAdmins(orgId, {
            title: '📍 Arrival',
            body: `${user.name} arrived at ${nextPlace.name}`,
            tag: `geofence-arrival-${user._id}`,
            data: { url: '/team-pulse?tab=activity' },
        }, user._id.toString());
    }
}

const getMyLocatorStatus = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);

    const location = await EmployeeLocation.findOne({ userId: actor.id }).lean();
    const { isOnShift, isOnBreak } = await getShiftStatusForActor(actor.id);

    res.json(new ApiResponse(200, {
        employmentLocationType: (actor.doc as any).employmentLocationType ?? 'onsite',
        locationConsent: actor.locationConsent ?? { granted: false },
        sharingState: location?.sharingState ?? 'off_duty',
        coords: location?.coords ?? null,
        lastSeenAt: location?.lastSeenAt ?? null,
        isMandatoryDept: await isMandatoryLocationDept(actor.organizationId, actor.department),
        locationSharingOptOut: !!actor.locationSharingOptOut,
        isOnShift,
        isOnBreak,
    }, 'Locator status fetched'));
});

const setLocationConsent = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { granted, deviceHint } = req.body as { granted: boolean; deviceHint?: string };

    const alreadySet = !!actor.locationConsent?.granted === !!granted;

    if (!granted) {
        await assertCanTurnOffLocation(actor, orgId);
    }

    await updateActorLocationConsent(actor, !!granted, deviceHint);

    if (alreadySet) {
        res.json(new ApiResponse(200, { granted: !!granted }, 'Location consent updated'));
        return;
    }

    if (!granted) {
        await EmployeeLocation.findOneAndUpdate(
            { userId: actor.id },
            {
                organizationId: orgId,
                userModel: actor.model,
                ...actorSnapshot(actor),
                sharingState: 'off_duty',
                $unset: { currentPlaceId: '' },
            },
            { upsert: true },
        );
        emitToOrg(orgId, 'locator:sharing_state_changed', {
            userId: actor.id.toString(),
            sharingState: 'off_duty',
        });
        handleLocationTurnedOff(actor, orgId).catch(() => {});
    }

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        userAvatar: actor.avatar,
        type: granted ? 'location_sharing_started' : 'location_sharing_stopped',
        description: granted ? `${actor.name} turned on location sharing` : `${actor.name} turned off location sharing`,
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { granted: !!granted }, 'Location consent updated'));
});

const setLocationSharingOptOut = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { optOut } = req.body as { optOut: boolean };

    if (optOut) {
        await assertCanTurnOffLocation(actor, orgId);
    }

    const update = { locationSharingOptOut: !!optOut };
    if (actor.model === 'CrmUser') {
        await CrmUser.findByIdAndUpdate(actor.id, update);
    } else {
        await User.findByIdAndUpdate(actor.id, update);
        invalidateUserCache(actor.id.toString());
    }

    if (optOut) {
        await EmployeeLocation.findOneAndUpdate(
            { userId: actor.id },
            {
                organizationId: orgId,
                userModel: actor.model,
                ...actorSnapshot(actor),
                sharingState: 'off_duty',
                $unset: { currentPlaceId: '' },
            },
            { upsert: true },
        );
        emitToOrg(orgId, 'locator:sharing_state_changed', {
            userId: actor.id.toString(),
            sharingState: 'off_duty',
        });
        // Only a genuine ON→OFF transition counts — re-saving optOut:true when
        // it was already true shouldn't re-fire the alert/re-clock-out someone.
        if (!actor.locationSharingOptOut) {
            handleLocationTurnedOff(actor, orgId).catch(() => {});
        }
    }

    res.json(new ApiResponse(200, { optOut: !!optOut }, 'Location sharing preference updated'));
});

const KNOWN_CONNECTION_TYPES = new Set(['wifi', 'ethernet', 'cellular', 'bluetooth', 'wimax', 'none']);
const KNOWN_EFFECTIVE_TYPES = new Set(['4g', '3g', '2g', 'slow-2g']);

const ingestLocation = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const {
        lat, lng, heading, speedMph, accuracyM, batteryLevel, isCharging, connectivity,
        deviceType, connectionType: rawConnectionType, effectiveType: rawEffectiveType, downlinkMbps,
    } = req.body as {
        lat: number; lng: number; heading?: number; speedMph?: number; accuracyM?: number;
        batteryLevel?: number; isCharging?: boolean; connectivity?: 'online' | 'offline';
        deviceType?: 'mobile' | 'desktop'; connectionType?: string; effectiveType?: string; downlinkMbps?: number;
    };
    const connectionType = typeof rawConnectionType === 'string' && KNOWN_CONNECTION_TYPES.has(rawConnectionType.toLowerCase())
        ? rawConnectionType.toLowerCase()
        : undefined;
    const effectiveType = typeof rawEffectiveType === 'string' && KNOWN_EFFECTIVE_TYPES.has(rawEffectiveType.toLowerCase())
        ? rawEffectiveType.toLowerCase()
        : undefined;

    if (!actor.locationConsent?.granted) {
        throw new ApiError(403, 'Location sharing requires consent');
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        throw new ApiError(400, 'lat and lng are required');
    }

    const previous = await EmployeeLocation.findOne({ userId: actor.id }).lean();
    // A fix this coarse (WiFi/cell-tower positioning, hundreds of meters off) must never be
    // plotted as the person's actual position at all — see POSITION_ACCURACY_REJECT_M above.
    const positionReliable = typeof accuracyM !== 'number' || accuracyM <= POSITION_ACCURACY_REJECT_M;
    // A coarse fix must never be trusted to move someone in/out of a geofence either —
    // undefined here means "unknown/unreliable", handled below by leaving currentPlaceId
    // untouched rather than treating it as "not at any place". Implied false whenever
    // positionReliable is false, since GEOFENCE_ACCURACY_THRESHOLD_M < POSITION_ACCURACY_REJECT_M.
    const accuracyReliable = positionReliable && (typeof accuracyM !== 'number' || accuracyM <= GEOFENCE_ACCURACY_THRESHOLD_M);
    const nextPlace = accuracyReliable
        ? await resolveCurrentPlace(orgId, lat, lng, previous?.currentPlaceId?.toString())
        : undefined;
    const isLotTech = await isMobileMonitoringDept(actor.organizationId, actor.department);

    const isNewSharingSession = !previous || previous.sharingState !== 'sharing';

    // A brand-new sharing session always restarts the "stayed put" clock — without this, an
    // anchor set days ago (e.g. someone's usual desk) never resets across separate pause/off
    // -duty/resume cycles as long as the GPS position keeps landing in the same spot, so the
    // "stayed put" duration can silently read as days/weeks even though the person was only
    // actively sharing for a few minutes at a time.
    const prevAnchor = isNewSharingSession ? undefined : previous?.stationaryAnchor;
    const isNewAnchor = !prevAnchor || distanceMeters(prevAnchor.lat, prevAnchor.lng, lat, lng) > STATIONARY_RADIUS_M;
    const stationaryAnchor = isNewAnchor ? { lat, lng } : prevAnchor;
    const stationarySince = isNewAnchor ? new Date() : (previous?.stationarySince ?? new Date());

    const updated = await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        {
            organizationId: orgId,
            userModel: actor.model,
            ...actorSnapshot(actor),
            // coords is a required field — a brand-new doc (no previous fix to fall back to)
            // always gets this ping's position no matter the accuracy, since a wrong dot is
            // still better than no dot at all the very first time someone shares.
            ...(positionReliable || !previous ? { coords: { lat, lng }, heading, speedMph } : {}),
            accuracyM, batteryLevel, isCharging,
            connectivity: connectivity === 'offline' ? 'offline' : 'online',
            deviceType, connectionType, effectiveType, downlinkMbps,
            sharingState: 'sharing',
            ...(accuracyReliable ? { currentPlaceId: nextPlace?._id ?? null } : {}),
            lastSeenAt: new Date(),
            stationaryAnchor, stationarySince,
            ...(isNewSharingSession ? { sharingSince: new Date() } : {}),
            ...(isNewAnchor ? { stationaryNotifiedAt: null } : {}),
            permissionDeniedNotifiedAt: null,
            locationIssueDetectedAt: null,
            locationWarningStage: 0,
        },
        { upsert: true, new: true },
    );

    emitToOrg(orgId, 'locator:location_update', {
        userId: actor.id.toString(),
        userName: actor.name,
        userAvatar: actor.avatar,
        coords: updated.coords,
        sharingState: updated.sharingState,
        heading: updated.heading,
        speedMph: updated.speedMph,
        accuracyM: updated.accuracyM,
        batteryLevel: updated.batteryLevel,
        isCharging: updated.isCharging,
        connectivity: updated.connectivity,
        deviceType: updated.deviceType,
        connectionType: updated.connectionType,
        effectiveType: updated.effectiveType,
        downlinkMbps: updated.downlinkMbps,
        currentPlaceId: updated.currentPlaceId,
        lastSeenAt: updated.lastSeenAt,
        sharingSince: updated.sharingSince,
        stationarySince: updated.stationarySince,
    });

    if (accuracyReliable) {
        handleGeofenceTransition(
            orgId,
            actor,
            previous?.currentPlaceId?.toString(),
            nextPlace ?? null,
        ).catch(() => {});
    }

    if (isLotTech) {
        const nowMs = Date.now();

        if (
            previous?.lastSeenAt &&
            previous.sharingState === 'sharing' &&
            nowMs - new Date(previous.lastSeenAt).getTime() > LOT_TECH_OFFLINE_THRESHOLD_MS
        ) {
            const offlineMin = Math.round((nowMs - new Date(previous.lastSeenAt).getTime()) / 60000);
            notifyAdmins(orgId, {
                title: '📶 Back Online',
                body: `${actor.name} was offline for ~${offlineMin} min and is now back`,
                tag: `lot-tech-offline-${actor.id}`,
                data: { url: '/team-pulse?tab=activity' },
            });
        }

        const stationaryMs = updated.stationarySince
            ? nowMs - new Date(updated.stationarySince).getTime()
            : 0;
        const alreadyNotifiedThisPeriod =
            updated.stationaryNotifiedAt &&
            updated.stationarySince &&
            new Date(updated.stationaryNotifiedAt) > new Date(updated.stationarySince);

        if (stationaryMs > LOT_TECH_STATIONARY_THRESHOLD_MS && !alreadyNotifiedThisPeriod) {
            const stationaryMin = Math.round(stationaryMs / 60000);
            notifyAdmins(orgId, {
                title: '⚠️ Not Moving',
                body: `${actor.name} hasn't moved in ${stationaryMin} minutes`,
                tag: `lot-tech-stationary-${actor.id}`,
                data: { url: '/team-pulse?tab=activity' },
            });
            EmployeeLocation.findOneAndUpdate(
                { userId: actor.id },
                { stationaryNotifiedAt: new Date() },
            ).catch(() => {});
        }
    }

    const isDriving = !!updated.drivingSessionId;
    const sinceLastHistory = previous?.lastSeenAt ? Date.now() - new Date(previous.lastSeenAt).getTime() : Infinity;

    if (isDriving) {
        await updateDrivingTelematics(orgId, updated.drivingSessionId, { _id: actor.id, name: actor.name } as IUser, lat, lng, speedMph);
    }

    // A rejected-accuracy fix must never enter the breadcrumb trail either — this is exactly
    // what produced the reported "history jumps backward to a previous point": a bad fix
    // recorded mid-trail, then map-matched/connected like a real waypoint.
    if (positionReliable && (isDriving || sinceLastHistory >= HISTORY_THROTTLE_MS)) {
        LocationHistory.create({
            userId: actor.id,
            organizationId: orgId,
            coords: { lat, lng },
            speedMph,
            drivingSessionId: updated.drivingSessionId,
            recordedAt: new Date(),
        }).catch(() => {});
    }

    res.json(new ApiResponse(200, { sharingState: updated.sharingState, currentPlaceId: updated.currentPlaceId }, 'Location updated'));
});

const pauseSharing = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { reason } = req.body as { reason?: 'manual' | 'break' };
    const sharingState = reason === 'break' ? 'paused_break' : 'paused_manual';

    await assertCanTurnOffLocation(actor, orgId, { isBreakPause: reason === 'break' });

    const existing = await EmployeeLocation.findOne({ userId: actor.id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === sharingState;

    await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        {
            organizationId: orgId, userModel: actor.model, ...actorSnapshot(actor), sharingState,
            // Break time isn't a location violation — cancel any in-flight escalation so the
            // elapsed-time clock doesn't keep ticking silently through the break.
            locationIssueDetectedAt: null,
            locationWarningStage: 0,
        },
        { upsert: true },
    );

    if (alreadySet) {
        res.json(new ApiResponse(200, { sharingState }, 'Location sharing paused'));
        return;
    }

    emitToOrg(orgId, 'locator:sharing_state_changed', { userId: actor.id.toString(), sharingState });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        userAvatar: actor.avatar,
        type: 'location_sharing_paused',
        description: `${actor.name} paused location sharing`,
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { sharingState }, 'Location sharing paused'));
});

// Reported by the client the moment it detects OS/browser location permission was denied —
// the one way sharing can stop that never hits a guarded endpoint (assertCanTurnOffLocation
// can't block what never calls it), so this exists purely to alert admins fast instead of
// waiting up to ~15min for the connection-lost cron to notice the row went silent.
const reportPermissionDenied = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    if (!orgId) { res.json(new ApiResponse(200, {}, 'Ignored — no organization')); return; }

    const { isOnShift, isOnBreak } = await getShiftStatusForActor(actor.id);
    if (!isOnShift || isOnBreak) { res.json(new ApiResponse(200, {}, 'Ignored — not on shift')); return; }

    if (!(await isLocationRequiredForUser(orgId, actor.department, actor.locationRequiredOverride))) {
        res.json(new ApiResponse(200, {}, 'Ignored — location not required for this account')); return;
    }

    // Stage 1 of the mandatory-dept location-loss escalation (see lotTechLocationEscalation
    // scheduler) — locationIssueDetectedAt anchors the +5/+10/+15min warning/clockout timeline.
    const claimed = await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id, permissionDeniedNotifiedAt: null },
        {
            permissionDeniedNotifiedAt: new Date(),
            sharingState: 'declined_permission',
            locationIssueDetectedAt: new Date(),
            locationWarningStage: 1,
        },
    );
    if (!claimed) { res.json(new ApiResponse(200, {}, 'Already notified')); return; }

    emitToOrg(orgId, 'locator:sharing_state_changed', { userId: actor.id.toString(), sharingState: 'declined_permission' });

    // notifyTitle/notifyBody go to BOTH admins and the affected employee (fireShiftAlert's
    // notifyTargetUser) — phrased as a direct instruction so it reads correctly either way.
    // chatMessage (admin-only Shift Alerts channel) keeps the name for admin context.
    await fireShiftAlert({
        organizationId: orgId,
        targetUserId: actor.id.toString(),
        targetUserModel: actor.model,
        chatMessage: `🚫 ${actor.name} turned off location access while clocked in.`,
        notifyTitle: '🚫 Location Turned Off',
        notifyBody: 'Location access was turned off while clocked in — please turn it back on to continue your shift.',
        notifyTag: `shift-alert-permission-denied-${actor.id}`,
        url: `/crm/timeproof/users/${actor.id}`,
    });

    res.json(new ApiResponse(200, {}, 'Reported'));
});

const resumeSharing = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;

    if (!actor.locationConsent?.granted) {
        throw new ApiError(403, 'Location sharing is not enabled for this account');
    }

    const existing = await EmployeeLocation.findOne({ userId: actor.id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === 'sharing';

    const updated = await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        { organizationId: orgId, userModel: actor.model, ...actorSnapshot(actor), sharingState: 'sharing', sharingSince: new Date() },
        { upsert: true, new: true },
    );

    if (alreadySet) {
        res.json(new ApiResponse(200, { sharingState: updated.sharingState }, 'Location sharing resumed'));
        return;
    }

    emitToOrg(orgId, 'locator:sharing_state_changed', { userId: actor.id.toString(), sharingState: updated.sharingState });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        userAvatar: actor.avatar,
        type: 'location_sharing_resumed',
        description: `${actor.name} resumed location sharing`,
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { sharingState: updated.sharingState }, 'Location sharing resumed'));
});

const stopSharing = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;

    await assertCanTurnOffLocation(actor, orgId);

    const existing = await EmployeeLocation.findOne({ userId: actor.id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === 'off_duty';

    await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        {
            organizationId: orgId,
            userModel: actor.model,
            ...actorSnapshot(actor),
            sharingState: 'off_duty',
            $unset: { currentPlaceId: '' },
        },
        { upsert: true },
    );

    if (!alreadySet) {
        emitToOrg(orgId, 'locator:sharing_state_changed', {
            userId: actor.id.toString(),
            sharingState: 'off_duty',
        });
    }

    res.json(new ApiResponse(200, { sharingState: 'off_duty' }, 'Location sharing stopped'));
});

/** Higher = "more alive" — actively sharing beats paused beats off-duty. Used to pick a winner
 * when the same human shows up twice (see getActiveEmployeeLocations). Tie-break is the linked
 * account's model, NOT raw lastSeenAt recency: when someone has both a User and CrmUser account
 * simultaneously sharing (common since consent syncs across both, see syncLinkedAccountConsent),
 * two independent ~30s ping loops race, and recency-based tie-breaking made the "winning" row —
 * and therefore the userId the frontend keys markers by — flip between the two accounts almost
 * every poll, each flip swapping in the OTHER device's real position. That read as the person's
 * marker teleporting/glitching. Preferring the User row deterministically means the winner only
 * changes on a real state transition (one account actually stops sharing), never on a recency
 * coin-flip between two simultaneously-live rows. */
function locationLiveness(l: any): number {
    const stateRank = l.sharingState === 'sharing' ? 2 : l.sharingState?.startsWith('paused') ? 1 : 0;
    const modelRank = l.userModel === 'User' ? 1 : 0;
    return stateRank * 1e13 + modelRank * 1e12 + new Date(l.lastSeenAt || 0).getTime();
}

const getActiveEmployeeLocations = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    const locations = await EmployeeLocation.find({ organizationId: orgId })
        .populate('userId', 'name fullName email avatar department personalInfo.jobTitle personalInfo.department employmentLocationType')
        .lean();

    const withUser = locations.filter((l: any) => l.userId);

    // The same physical person can have both a main-site `User` account (Beacon page login) and
    // a separate `CrmUser` account (TimeProof clock page login) — two unrelated documents with
    // no schema link between them (see getLocatorActor). If both ever shared location, each
    // writes its own EmployeeLocation row, which otherwise renders as two pins for one human.
    // Email is the only identity signal common to both account types, so use it to collapse
    // duplicates, keeping whichever row is currently more "alive".
    const byPerson = new Map<string, any>();
    for (const l of withUser) {
        const key = (l.userId as any).email ? String((l.userId as any).email).toLowerCase() : `${l.userModel}:${l.userId._id}`;
        const existing = byPerson.get(key);
        if (!existing || locationLiveness(l) > locationLiveness(existing)) byPerson.set(key, l);
    }

    // A device that stops pinging forever (app killed, PWA closed, uninstalled) leaves its last
    // `sharingState: 'sharing'` row stuck that way indefinitely — nothing ever flips it, since
    // this feature deliberately has no cron job (see ingestLocation). Demote anything that's
    // gone quiet past SHARING_STALE_MS to 'off_duty' at read time, and self-heal the row so it
    // also drops out of "here now" place counts. Fire-and-forget, doesn't block the response.
    const nowMs = Date.now();
    const staleIds: any[] = [];
    for (const l of byPerson.values()) {
        if (l.sharingState === 'sharing' && nowMs - new Date(l.lastSeenAt).getTime() > SHARING_STALE_MS) {
            l.sharingState = 'off_duty';
            staleIds.push(l._id);
        }
    }
    if (staleIds.length > 0) {
        EmployeeLocation.updateMany({ _id: { $in: staleIds } }, { sharingState: 'off_duty' }).catch(() => {});
    }

    // Records written before the userName/userAvatar denormalization existed (or whose device
    // will never ping again to naturally refresh it) permanently fall back to the populated
    // user doc's name, or 'Team Member' if even that's missing — self-heal the snapshot fields
    // straight into the row the moment we successfully resolve them here, so the fix sticks
    // for good on the very next read instead of only masking it in this one response.
    for (const l of byPerson.values()) {
        if (l.userName) continue;
        const resolvedName = l.userId.name || l.userId.fullName || l.userId.email;
        if (!resolvedName) continue;
        EmployeeLocation.updateOne(
            { _id: l._id },
            {
                userName: resolvedName,
                userAvatar: l.userAvatar || l.userId.avatar,
                jobTitle: l.jobTitle || l.userId.personalInfo?.jobTitle,
                department: l.department || l.userId.department || l.userId.personalInfo?.department,
            },
        ).catch(() => {});
    }

    // The denormalized snapshot (written on every sharing-state change, see actorSnapshot())
    // is always preferred — it can't go stale/wrong the way a live populate can (deleted
    // account, refPath/collection mismatch on legacy records, etc.). Populated fields are
    // only a fallback for records written before the snapshot existed.
    const result = [...byPerson.values()]
        .map((l: any) => ({
            userId: l.userId._id,
            userModel: l.userModel,
            email: l.userId.email,
            userName: l.userName || l.userId.name || l.userId.fullName || l.userId.email || 'Team Member',
            userAvatar: l.userAvatar || l.userId.avatar,
            jobTitle: l.jobTitle || l.userId.personalInfo?.jobTitle,
            department: l.department || l.userId.department || l.userId.personalInfo?.department,
            employmentLocationType: l.userId.employmentLocationType,
            coords: l.coords,
            heading: l.heading,
            speedMph: l.speedMph,
            accuracyM: l.accuracyM,
            sharingState: l.sharingState,
            batteryLevel: l.batteryLevel,
            isCharging: l.isCharging,
            connectivity: l.connectivity,
            deviceType: l.deviceType,
            connectionType: l.connectionType,
            effectiveType: l.effectiveType,
            downlinkMbps: l.downlinkMbps,
            currentPlaceId: l.currentPlaceId,
            drivingSessionId: l.drivingSessionId,
            lastSeenAt: l.lastSeenAt,
            sharingSince: l.sharingSince,
            stationarySince: l.stationarySince,
        }));

    res.json(new ApiResponse(200, result, 'Active employee locations fetched'));
});

const requestLocationShare = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    if (!isAdmin) throw new ApiError(403, 'Only admins can request location sharing');

    const { userId } = req.params;
    const target = (await User.findOne({ _id: userId, organizationId: orgId }))
        || (await CrmUser.findOne({ _id: userId, organizationId: orgId }));
    if (!target) throw new ApiError(404, 'Team member not found');

    await notificationService.createNotification({
        userId: (target._id as any).toString(),
        organizationId: orgId,
        type: 'location_share_requested',
        title: '📍 Location Requested',
        message: `${actor.name} asked you to share your location`,
        metadata: { requestedBy: actor.id, route: '/team-pulse?tab=activity' },
    });

    res.json(new ApiResponse(200, { requested: true }, 'Location request sent'));
});

const getPlaces = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const places = await Place.find({ organizationId: orgId, isActive: true }).sort({ name: 1 }).lean();
    res.json(new ApiResponse(200, places, 'Places fetched'));
});

const createPlace = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    if (!isAdmin) throw new ApiError(403, 'Only admins can create places');

    const { name, lat, lng, radiusM, warningRadiusM, icon, color, address, description } = req.body as {
        name: string; lat: number; lng: number; radiusM?: number; warningRadiusM?: number; icon?: string; color?: string; address?: string; description?: string;
    };
    if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
        throw new ApiError(400, 'name, lat and lng are required');
    }
    if (warningRadiusM !== undefined && warningRadiusM <= (radiusM || 100)) {
        throw new ApiError(400, 'warningRadiusM must be greater than radiusM');
    }

    const place = await Place.create({
        organizationId: orgId,
        name, coords: { lat, lng },
        radiusM: radiusM || 100,
        warningRadiusM,
        icon, color, address, description,
        createdBy: actor.id,
    });

    emitToOrg(orgId, 'locator:place_created', { place });
    res.json(new ApiResponse(201, place, 'Place created'));
});

const updatePlace = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { id } = req.params;
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    if (!isAdmin) throw new ApiError(403, 'Only admins can update places');

    const { name, lat, lng, radiusM, warningRadiusM, icon, color, address, description, isActive } = req.body as Partial<{
        name: string; lat: number; lng: number; radiusM: number; warningRadiusM: number | null; icon: string; color: string; address: string; description: string; isActive: boolean;
    }>;

    const place = await Place.findOne({ _id: id, organizationId: orgId });
    if (!place) throw new ApiError(404, 'Place not found');

    if (name !== undefined) place.name = name;
    if (typeof lat === 'number' && typeof lng === 'number') place.coords = { lat, lng };
    if (radiusM !== undefined) place.radiusM = radiusM;
    if (warningRadiusM !== undefined) {
        const effectiveRadius = radiusM !== undefined ? radiusM : place.radiusM;
        if (warningRadiusM !== null && warningRadiusM <= effectiveRadius) {
            throw new ApiError(400, 'warningRadiusM must be greater than radiusM');
        }
        place.warningRadiusM = warningRadiusM ?? undefined;
    }
    if (icon !== undefined) place.icon = icon;
    if (color !== undefined) place.color = color;
    if (address !== undefined) place.address = address;
    if (description !== undefined) place.description = description;
    if (isActive !== undefined) place.isActive = isActive;
    await place.save();

    emitToOrg(orgId, 'locator:place_updated', { place });
    res.json(new ApiResponse(200, place, 'Place updated'));
});

const deletePlace = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { id } = req.params;
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    if (!isAdmin) throw new ApiError(403, 'Only admins can delete places');

    const place = await Place.findOneAndUpdate({ _id: id, organizationId: orgId }, { isActive: false });
    if (!place) throw new ApiError(404, 'Place not found');

    emitToOrg(orgId, 'locator:place_deleted', { placeId: id });
    res.json(new ApiResponse(200, null, 'Place deleted'));
});

const manualCheckIn = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { id } = req.params;

    const place = await Place.findOne({ _id: id, organizationId: orgId, isActive: true });
    if (!place) throw new ApiError(404, 'Place not found');

    const visit = await PlaceVisit.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        placeId: place._id,
        placeName: place.name,
        enteredAt: new Date(),
        method: 'manual_checkin',
    });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        userAvatar: actor.avatar,
        type: 'geofence_enter',
        description: `${actor.name} checked in at ${place.name}`,
        meta: { placeId: place._id, placeName: place.name, method: 'manual_checkin' },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:place_entered', {
        userId: actor.id.toString(), userName: actor.name,
        placeId: place._id, placeName: place.name, enteredAt: visit.enteredAt,
    });

    res.json(new ApiResponse(201, visit, 'Checked in'));
});

const getLocationHistory = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { userId } = req.params;
    const { from, to } = req.query as { from?: string; to?: string };

    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    const isSelf = actor.id.toString() === userId;
    if (!isAdmin && !isSelf) throw new ApiError(403, 'Not authorized to view this history');

    const query: any = { organizationId: orgId, userId };
    if (from || to) {
        query.recordedAt = {};
        if (from) query.recordedAt.$gte = new Date(from);
        if (to) query.recordedAt.$lte = new Date(to);
    }

    const history = await LocationHistory.find(query).sort({ recordedAt: -1 }).limit(10000).lean();
    history.reverse();
    res.json(new ApiResponse(200, history, 'Location history fetched'));
});

const getTimeAtPlaceReport = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { from, to, userId, placeId } = req.query as { from?: string; to?: string; userId?: string; placeId?: string };

    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    if (!isAdmin) throw new ApiError(403, 'Only admins can view time-at-place reports');

    const query: any = { organizationId: orgId, exitedAt: { $exists: true } };
    if (userId) query.userId = userId;
    if (placeId) query.placeId = placeId;
    if (from || to) {
        query.enteredAt = {};
        if (from) query.enteredAt.$gte = new Date(from);
        if (to) query.enteredAt.$lte = new Date(to);
    }

    const visits = await PlaceVisit.find(query).lean();

    const totals = new Map<string, { userId: string; userName: string; placeId: string; placeName: string; visits: number; totalMin: number }>();
    for (const v of visits) {
        const key = `${v.userId}:${v.placeId}`;
        const entry = totals.get(key) ?? {
            userId: v.userId.toString(), userName: v.userName,
            placeId: v.placeId.toString(), placeName: v.placeName,
            visits: 0, totalMin: 0,
        };
        entry.visits += 1;
        entry.totalMin += v.durationMin ?? 0;
        totals.set(key, entry);
    }

    res.json(new ApiResponse(200, Array.from(totals.values()), 'Time-at-place report fetched'));
});

const getDailyActivityLog = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { userId, date } = req.query as { userId?: string; date?: string };

    if (!date) throw new ApiError(400, 'date (YYYY-MM-DD) is required');
    const targetUserId = userId || actor.id.toString();
    const isAdmin = ['admin', 'super_admin', 'manager'].includes(actor.role || '');
    if (targetUserId !== actor.id.toString() && !isAdmin) {
        throw new ApiError(403, 'Not authorized to view this activity log');
    }

    const { start, end } = getCompanyDayRange(date);

    const [points, visits] = await Promise.all([
        LocationHistory.find({
            organizationId: orgId,
            userId: targetUserId,
            recordedAt: { $gte: start, $lt: end },
        }).sort({ recordedAt: 1 }).lean(),
        PlaceVisit.find({
            organizationId: orgId,
            userId: targetUserId,
            enteredAt: { $lt: end },
            $or: [{ exitedAt: { $gte: start } }, { exitedAt: { $exists: false } }],
        }).sort({ enteredAt: 1 }).lean(),
    ]);

    let distanceMi = 0;
    let topSpeedMph = 0;
    const stationarySegments: Array<{ start: Date; end: Date; durationMin: number }> = [];
    let segAnchor: { lat: number; lng: number } | null = null;
    let segStart: Date | null = null;

    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (typeof p.speedMph === 'number' && p.speedMph > topSpeedMph) topSpeedMph = p.speedMph;

        if (i > 0) {
            const prev = points[i - 1];
            distanceMi += distanceMeters(prev.coords.lat, prev.coords.lng, p.coords.lat, p.coords.lng) * METERS_TO_MILES;
        }

        const movedPastAnchor = !segAnchor || distanceMeters(segAnchor.lat, segAnchor.lng, p.coords.lat, p.coords.lng) > STATIONARY_RADIUS_M;
        if (movedPastAnchor) {
            if (segStart && segAnchor && i > 0) {
                const durationMin = Math.round((points[i - 1].recordedAt.getTime() - segStart.getTime()) / 60_000);
                if (durationMin >= STATIONARY_LOG_MIN_MINUTES) {
                    stationarySegments.push({ start: segStart, end: points[i - 1].recordedAt, durationMin });
                }
            }
            segAnchor = { lat: p.coords.lat, lng: p.coords.lng };
            segStart = p.recordedAt;
        }
    }
    if (segStart && points.length) {
        const lastPoint = points[points.length - 1];
        const durationMin = Math.round((lastPoint.recordedAt.getTime() - segStart.getTime()) / 60_000);
        if (durationMin >= STATIONARY_LOG_MIN_MINUTES) {
            stationarySegments.push({ start: segStart, end: lastPoint.recordedAt, durationMin });
        }
    }

    const placeVisits = visits.map((v) => ({
        placeName: v.placeName,
        enteredAt: v.enteredAt,
        exitedAt: v.exitedAt ?? null,
        durationMin: v.durationMin ?? null,
    }));

    res.json(new ApiResponse(200, {
        date,
        distanceMi: Math.round(distanceMi * 10) / 10,
        topSpeedMph: Math.round(topSpeedMph),
        stationaryMinutes: stationarySegments.reduce((sum, s) => sum + s.durationMin, 0),
        stationarySegments,
        placeVisits,
        pointCount: points.length,
    }, 'Daily activity log fetched'));
});

const getDrivingSessions = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { userId, from, to } = req.query as { userId?: string; from?: string; to?: string };
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');

    const query: any = { organizationId: orgId };
    if (userId) {
        if (!isAdmin && userId !== actor.id.toString()) throw new ApiError(403, 'Not authorized');
        query.userId = userId;
    } else if (!isAdmin) {
        query.userId = actor.id;
    }
    if (from || to) {
        query.startedAt = {};
        if (from) query.startedAt.$gte = new Date(from);
        if (to) query.startedAt.$lte = new Date(to);
    }

    const sessions = await DrivingSession.find(query).sort({ startedAt: -1 }).limit(100).lean();
    res.json(new ApiResponse(200, sessions, 'Driving sessions fetched'));
});

const getDrivingSessionDetail = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { id } = req.params;
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');

    const session = await DrivingSession.findOne({ _id: id, organizationId: orgId }).lean();
    if (!session) throw new ApiError(404, 'Driving session not found');
    if (!isAdmin && session.userId.toString() !== actor.id.toString()) throw new ApiError(403, 'Not authorized');

    const route = await LocationHistory.find({ drivingSessionId: id }).sort({ recordedAt: 1 }).lean();
    res.json(new ApiResponse(200, { session, route }, 'Driving session detail fetched'));
});

const respondToIncident = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { confirmed } = req.body as { confirmed: boolean };

    const session = await DrivingSession.findOne({ _id: id, organizationId: orgId });
    if (!session) throw new ApiError(404, 'Driving session not found');
    if (session.userId.toString() !== actor.id.toString()) throw new ApiError(403, 'Not authorized');
    if (!session.possibleIncident) throw new ApiError(400, 'No incident to respond to');

    session.possibleIncident.confirmed = confirmed;
    session.possibleIncident.respondedAt = new Date();
    await session.save();

    emitToOrg(orgId, 'locator:incident_resolved', { sessionId: session._id, confirmed });

    if (confirmed) {
        notifyAdmins(orgId, {
            title: '🚨 Incident Confirmed',
            body: `${actor.name} confirmed an incident during a test drive`,
            tag: `locator-incident-confirmed-${session._id}`,
            data: { url: '/team-pulse?tab=activity' },
        });
    }

    res.json(new ApiResponse(200, session, 'Incident response recorded'));
});

const triggerSos = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { lat, lng } = req.body as { lat: number; lng: number };
    if (typeof lat !== 'number' || typeof lng !== 'number') throw new ApiError(400, 'lat and lng are required');

    const alert = await SosAlert.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        coords: { lat, lng },
        status: 'active',
    });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: actor.id,
        userName: actor.name,
        userAvatar: actor.avatar,
        type: 'sos_triggered',
        description: `${actor.name} triggered an SOS alert`,
        meta: { sosId: alert._id, coords: alert.coords },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:sos_triggered', {
        sosId: alert._id, userId: actor.id.toString(), userName: actor.name,
        coords: alert.coords, createdAt: alert.createdAt,
    });

    notifyAdmins(orgId, {
        title: '🆘 SOS Alert',
        body: `${actor.name} triggered an SOS alert — respond immediately`,
        tag: `locator-sos-${alert._id}`,
        data: { url: '/team-pulse?tab=activity' },
    });

    res.json(new ApiResponse(201, alert, 'SOS alert triggered'));
});

const resolveSos = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { status, note } = req.body as { status: 'resolved' | 'false_alarm'; note?: string };
    const isAdmin = ['admin', 'super_admin'].includes(actor.role || '');
    if (!isAdmin) throw new ApiError(403, 'Only admins can resolve SOS alerts');

    const alert = await SosAlert.findOne({ _id: id, organizationId: orgId });
    if (!alert) throw new ApiError(404, 'SOS alert not found');

    alert.status = status === 'false_alarm' ? 'false_alarm' : 'resolved';
    alert.resolvedBy = actor.id;
    alert.resolvedAt = new Date();
    alert.resolutionNote = note;
    await alert.save();

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: alert.userId,
        userName: alert.userName,
        type: 'sos_resolved',
        description: `${alert.userName}'s SOS alert was ${alert.status === 'false_alarm' ? 'marked as a false alarm' : 'resolved'} by ${actor.name}`,
        meta: { sosId: alert._id },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:sos_resolved', { sosId: alert._id, status: alert.status, resolvedBy: actor.name });

    res.json(new ApiResponse(200, alert, 'SOS alert resolved'));
});

const getActiveSosAlerts = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    const alerts = await SosAlert.find({ organizationId: orgId, status: 'active' }).sort({ createdAt: -1 }).lean();
    res.json(new ApiResponse(200, alerts, 'Active SOS alerts fetched'));
});

export default {
    getMyLocatorStatus, setLocationConsent, setLocationSharingOptOut,
    ingestLocation, pauseSharing, resumeSharing, stopSharing, getActiveEmployeeLocations,
    reportPermissionDenied,
    requestLocationShare,
    getPlaces, createPlace, updatePlace, deletePlace, manualCheckIn,
    getLocationHistory, getTimeAtPlaceReport, getDailyActivityLog,
    getDrivingSessions, getDrivingSessionDetail, respondToIncident,
    triggerSos, resolveSos, getActiveSosAlerts,
};
