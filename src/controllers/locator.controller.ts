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
import { PushService } from '../services/push.service';
import { isMobileMonitoringDept } from '../config/departmentMonitoring';
import { getCompanyDayRange } from '../utils/companyTimezone';

const HISTORY_THROTTLE_MS = 30_000;
const HARSH_BRAKING_DROP_MPH = 15;
const INCIDENT_PRIOR_SPEED_MPH = 25;
const INCIDENT_STOP_SPEED_MPH = 3;
const METERS_TO_MILES = 0.000621371;
const SPEEDING_THRESHOLD_MPH = 80;
const STATIONARY_RADIUS_M = 40;
const LOT_TECH_STATIONARY_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes
const LOT_TECH_OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;    // 10 minutes
// Minimum length of a "stayed in the same spot" block before it's worth showing
// as its own segment in the daily activity log (shorter gaps are just noise).
const STATIONARY_LOG_MIN_MINUTES = 10;

type LocatorActor = {
    doc: IUser | ICrmUser;
    model: 'User' | 'CrmUser';
    id: any;
    name: string;
    avatar?: string | null;
    organizationId?: any;
    role?: string;
    department?: string;
    locationConsent?: { granted?: boolean; grantedAt?: Date; deviceHint?: string };
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
        avatar: anyDoc.avatar,
        organizationId: anyDoc.organizationId,
        role: anyDoc.role,
        department: anyDoc.department ?? anyDoc.personalInfo?.department,
        locationConsent: anyDoc.locationConsent,
    };
}

async function updateActorLocationConsent(actor: LocatorActor, granted: boolean, deviceHint?: string) {
    const update = { locationConsent: { granted, grantedAt: new Date(), deviceHint } };
    if (actor.model === 'CrmUser') {
        await CrmUser.findByIdAndUpdate(actor.id, update);
    } else {
        await User.findByIdAndUpdate(actor.id, update);
    }
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

        // Count crossings into the speeding zone, not every ping spent above it, so one long
        // stretch of highway speed registers as one event rather than a dozen.
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

function notifyAdmins(orgId: string, payload: { title: string; body: string; tag?: string; data?: Record<string, any> }) {
    PushService.notifyOrgAdmins(orgId, payload).catch(() => {});
}

async function findNearestPlace(orgId: string, lat: number, lng: number) {
    const places = await Place.find({ organizationId: orgId, isActive: true }).lean();
    for (const place of places) {
        const distance = distanceMeters(lat, lng, place.coords.lat, place.coords.lng);
        if (distance <= place.radiusM) return place;
    }
    return null;
}

async function handleGeofenceTransition(
    orgId: string,
    user: { _id: any; name: string; avatar?: string | null },
    previousPlaceId: string | undefined | null,
    nextPlace: { _id: any; name: string } | null,
    isLotTech = false,
) {
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
            if (isLotTech) {
                notifyAdmins(orgId, {
                    title: '🚨 Left Premises',
                    body: `${user.name} left ${visit.placeName}`,
                    tag: `lot-tech-exit-${user._id}`,
                    data: { url: '/team-pulse?tab=activity' },
                });
            }
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
        if (isLotTech) {
            notifyAdmins(orgId, {
                title: '📍 Arrival',
                body: `${user.name} arrived at ${nextPlace.name}`,
                tag: `locator-arrival-${user._id}`,
                data: { url: '/team-pulse?tab=activity' },
            });
        }
    }
}

// ── Consent & status ────────────────────────────────────────────────────────────

const getMyLocatorStatus = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);

    const location = await EmployeeLocation.findOne({ userId: actor.id }).lean();

    res.json(new ApiResponse(200, {
        employmentLocationType: (actor.doc as any).employmentLocationType ?? 'onsite',
        locationConsent: actor.locationConsent ?? { granted: false },
        sharingState: location?.sharingState ?? 'off_duty',
        coords: location?.coords ?? null,
        lastSeenAt: location?.lastSeenAt ?? null,
    }, 'Locator status fetched'));
});

const setLocationConsent = asyncHandler(async (req: Request, res: Response) => {
    const actor = getLocatorActor(req);
    const orgId = req.orgId as string;
    const { granted, deviceHint } = req.body as { granted: boolean; deviceHint?: string };

    const alreadySet = !!actor.locationConsent?.granted === !!granted;

    await updateActorLocationConsent(actor, !!granted, deviceHint);

    if (alreadySet) {
        res.json(new ApiResponse(200, { granted: !!granted }, 'Location consent updated'));
        return;
    }

    if (!granted) {
        // Explicit opt-out — drop them off the live map entirely.
        await EmployeeLocation.findOneAndUpdate(
            { userId: actor.id },
            {
                organizationId: orgId,
                userModel: actor.model,
                sharingState: 'off_duty',
                $unset: { currentPlaceId: '' },
            },
            { upsert: true },
        );
        emitToOrg(orgId, 'locator:sharing_state_changed', {
            userId: actor.id.toString(),
            sharingState: 'off_duty',
        });
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

// ── Live ingest ──────────────────────────────────────────────────────────────

// Whitelisted so a client can't stuff arbitrary/oversized strings into a field that gets
// rendered (even though the frontend also escapes it — this is the second layer, not the only one).
// `connectionType` is the real physical medium; `effectiveType` is a separate bandwidth-class
// heuristic ("4g" etc.) that must never be conflated with an actual cellular connectionType —
// that conflation is exactly what made desktop Wi-Fi/Ethernet users show up mislabeled "4G".
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
    const nextPlace = await findNearestPlace(orgId, lat, lng);
    const isLotTech = isMobileMonitoringDept(actor.department);

    // A fresh continuous sharing session — used to show "sharing for Xh" instead of just a timestamp.
    const isNewSharingSession = !previous || previous.sharingState !== 'sharing';

    // "Has this person basically stayed in one spot" — the anchor only resets once a ping lands
    // outside STATIONARY_RADIUS_M of it, so ordinary GPS jitter (a few meters of noise while
    // truly standing still) doesn't keep resetting the clock.
    const prevAnchor = previous?.stationaryAnchor;
    const isNewAnchor = !prevAnchor || distanceMeters(prevAnchor.lat, prevAnchor.lng, lat, lng) > STATIONARY_RADIUS_M;
    const stationaryAnchor = isNewAnchor ? { lat, lng } : prevAnchor;
    const stationarySince = isNewAnchor ? new Date() : (previous?.stationarySince ?? new Date());

    const updated = await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        {
            organizationId: orgId,
            userModel: actor.model,
            coords: { lat, lng },
            heading, speedMph, accuracyM, batteryLevel, isCharging,
            connectivity: connectivity === 'offline' ? 'offline' : 'online',
            deviceType, connectionType, effectiveType, downlinkMbps,
            sharingState: 'sharing',
            currentPlaceId: nextPlace?._id ?? null,
            lastSeenAt: new Date(),
            stationaryAnchor, stationarySince,
            ...(isNewSharingSession ? { sharingSince: new Date() } : {}),
            // Clear the stationary notification flag whenever the anchor resets (employee moved),
            // so the next stationary period can fire its own notification fresh.
            ...(isNewAnchor ? { stationaryNotifiedAt: null } : {}),
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

    handleGeofenceTransition(
        orgId,
        { _id: actor.id, name: actor.name, avatar: actor.avatar },
        previous?.currentPlaceId?.toString(),
        nextPlace,
        isLotTech,
    ).catch(() => {});

    // ── Lot Tech monitoring alerts ───────────────────────────────────────────
    if (isLotTech) {
        const nowMs = Date.now();

        // Offline detection: if the previous ping was > 10 min ago while actively sharing,
        // the employee just came back online after a gap — notify admin once.
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

        // Stationary alert: if the employee hasn't moved for 45+ min, notify admin once per
        // stationary period (stationaryNotifiedAt is cleared whenever the anchor resets).
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

    if (isDriving || sinceLastHistory >= HISTORY_THROTTLE_MS) {
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

    const existing = await EmployeeLocation.findOne({ userId: actor.id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === sharingState;

    await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        { organizationId: orgId, userModel: actor.model, sharingState },
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
        { organizationId: orgId, userModel: actor.model, sharingState: 'sharing', sharingSince: new Date() },
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

    const existing = await EmployeeLocation.findOne({ userId: actor.id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === 'off_duty';

    await EmployeeLocation.findOneAndUpdate(
        { userId: actor.id },
        {
            organizationId: orgId,
            userModel: actor.model,
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

const getActiveEmployeeLocations = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    // Visible to everyone in the dealership — the live map is a team-wide tool.
    const locations = await EmployeeLocation.find({ organizationId: orgId })
        .populate('userId', 'name fullName avatar department personalInfo.jobTitle personalInfo.department employmentLocationType')
        .lean();

    const result = locations
        .filter((l: any) => l.userId)
        .map((l: any) => ({
            userId: l.userId._id,
            userModel: l.userModel,
            userName: l.userId.name || l.userId.fullName || 'Team member',
            userAvatar: l.userId.avatar,
            jobTitle: l.userId.personalInfo?.jobTitle,
            // CrmUser has department as a direct field; User has it nested in personalInfo.
            department: l.userId.department || l.userId.personalInfo?.department,
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

// ── Places (admin-only CRUD) ────────────────────────────────────────────────────

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

    const { name, lat, lng, radiusM, icon, color, address } = req.body as {
        name: string; lat: number; lng: number; radiusM?: number; icon?: string; color?: string; address?: string;
    };
    if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
        throw new ApiError(400, 'name, lat and lng are required');
    }

    const place = await Place.create({
        organizationId: orgId,
        name, coords: { lat, lng },
        radiusM: radiusM || 100,
        icon, color, address,
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

    const { name, lat, lng, radiusM, icon, color, address, isActive } = req.body as Partial<{
        name: string; lat: number; lng: number; radiusM: number; icon: string; color: string; address: string; isActive: boolean;
    }>;

    const place = await Place.findOne({ _id: id, organizationId: orgId });
    if (!place) throw new ApiError(404, 'Place not found');

    if (name !== undefined) place.name = name;
    if (typeof lat === 'number' && typeof lng === 'number') place.coords = { lat, lng };
    if (radiusM !== undefined) place.radiusM = radiusM;
    if (icon !== undefined) place.icon = icon;
    if (color !== undefined) place.color = color;
    if (address !== undefined) place.address = address;
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

// ── History & reporting ──────────────────────────────────────────────────────

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

    // Sort newest-first when capping at 2000 so a long continuous share (e.g. an all-day
    // drive) keeps its most RECENT points instead of silently truncating them off the end —
    // then reverse back to chronological order, which the map trail/time-range display expect.
    const history = await LocationHistory.find(query).sort({ recordedAt: -1 }).limit(2000).lean();
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

// ── Daily activity log (mobile-monitoring departments, e.g. Lot Tech) ────────
// Replaces "screenshots" as the proof-of-work record for departments that use
// phone-only clock-in: movement/place visits + distance + top speed +
// stationary blocks, derived from LocationHistory pings for one calendar day.
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

// ── Driving sessions ─────────────────────────────────────────────────────────

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

// ── SOS ───────────────────────────────────────────────────────────────────────

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

    // Active SOS alerts are visible to everyone so the whole team can respond.
    const alerts = await SosAlert.find({ organizationId: orgId, status: 'active' }).sort({ createdAt: -1 }).lean();
    res.json(new ApiResponse(200, alerts, 'Active SOS alerts fetched'));
});

export default {
    getMyLocatorStatus, setLocationConsent,
    ingestLocation, pauseSharing, resumeSharing, stopSharing, getActiveEmployeeLocations,
    getPlaces, createPlace, updatePlace, deletePlace, manualCheckIn,
    getLocationHistory, getTimeAtPlaceReport, getDailyActivityLog,
    getDrivingSessions, getDrivingSessionDetail, respondToIncident,
    triggerSos, resolveSos, getActiveSosAlerts,
};
