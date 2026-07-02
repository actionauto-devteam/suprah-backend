import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
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

const HISTORY_THROTTLE_MS = 30_000;
const HARSH_BRAKING_DROP_MPH = 15;
const INCIDENT_PRIOR_SPEED_MPH = 25;
const INCIDENT_STOP_SPEED_MPH = 3;
const METERS_TO_MILES = 0.000621371;

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

async function notifyAdmins(orgId: string, payload: { title: string; body: string; tag?: string; data?: Record<string, any> }) {
    const admins = await User.find({ organizationId: orgId, role: { $in: ['admin', 'super_admin'] } }).select('_id').lean();
    if (admins.length === 0) return;
    PushService.broadcast(admins.map((a) => a._id), { icon: '/icon-192x192.png', ...payload }).catch(() => {});
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
    user: IUser,
    previousPlaceId: string | undefined | null,
    nextPlace: { _id: any; name: string } | null,
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
        notifyAdmins(orgId, {
            title: '📍 Arrival',
            body: `${user.name} arrived at ${nextPlace.name}`,
            tag: `locator-arrival-${user._id}`,
            data: { url: '/team-pulse?tab=activity' },
        });
    }
}

// ── Consent & status ────────────────────────────────────────────────────────────

const getMyLocatorStatus = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;

    const location = await EmployeeLocation.findOne({ userId: user._id }).lean();

    res.json(new ApiResponse(200, {
        employmentLocationType: user.employmentLocationType,
        locationConsent: user.locationConsent ?? { granted: false },
        sharingState: location?.sharingState ?? 'off_duty',
        coords: location?.coords ?? null,
        lastSeenAt: location?.lastSeenAt ?? null,
    }, 'Locator status fetched'));
});

const setLocationConsent = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { granted, deviceHint } = req.body as { granted: boolean; deviceHint?: string };

    const alreadySet = !!user.locationConsent?.granted === !!granted;

    const now = new Date();
    await User.findByIdAndUpdate(user._id, {
        locationConsent: { granted: !!granted, grantedAt: now, deviceHint },
    });

    if (alreadySet) {
        res.json(new ApiResponse(200, { granted: !!granted }, 'Location consent updated'));
        return;
    }

    if (!granted) {
        // Explicit opt-out — drop them off the live map entirely.
        await EmployeeLocation.findOneAndUpdate(
            { userId: user._id },
            {
                organizationId: orgId,
                sharingState: 'off_duty',
                $unset: { currentPlaceId: '' },
            },
            { upsert: true },
        );
        emitToOrg(orgId, 'locator:sharing_state_changed', {
            userId: user._id.toString(),
            sharingState: 'off_duty',
        });
    }

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        userAvatar: user.avatar,
        type: granted ? 'location_sharing_started' : 'location_sharing_stopped',
        description: granted ? `${user.name} turned on location sharing` : `${user.name} turned off location sharing`,
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { granted: !!granted }, 'Location consent updated'));
});

// ── Live ingest ──────────────────────────────────────────────────────────────

const ingestLocation = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { lat, lng, heading, speedMph, accuracyM, batteryLevel, isCharging, connectivity } = req.body as {
        lat: number; lng: number; heading?: number; speedMph?: number; accuracyM?: number;
        batteryLevel?: number; isCharging?: boolean; connectivity?: 'online' | 'offline';
    };

    if (!user.locationConsent?.granted) {
        throw new ApiError(403, 'Location sharing requires consent');
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        throw new ApiError(400, 'lat and lng are required');
    }

    const previous = await EmployeeLocation.findOne({ userId: user._id }).lean();
    const nextPlace = await findNearestPlace(orgId, lat, lng);

    const updated = await EmployeeLocation.findOneAndUpdate(
        { userId: user._id },
        {
            organizationId: orgId,
            coords: { lat, lng },
            heading, speedMph, accuracyM, batteryLevel, isCharging,
            connectivity: connectivity === 'offline' ? 'offline' : 'online',
            sharingState: 'sharing',
            currentPlaceId: nextPlace?._id ?? null,
            lastSeenAt: new Date(),
        },
        { upsert: true, new: true },
    );

    emitToOrg(orgId, 'locator:location_update', {
        userId: user._id.toString(),
        coords: updated.coords,
        sharingState: updated.sharingState,
        heading: updated.heading,
        speedMph: updated.speedMph,
        batteryLevel: updated.batteryLevel,
        isCharging: updated.isCharging,
        connectivity: updated.connectivity,
        currentPlaceId: updated.currentPlaceId,
        lastSeenAt: updated.lastSeenAt,
    });

    handleGeofenceTransition(orgId, user, previous?.currentPlaceId?.toString(), nextPlace).catch(() => {});

    const isDriving = !!updated.drivingSessionId;
    const sinceLastHistory = previous?.lastSeenAt ? Date.now() - new Date(previous.lastSeenAt).getTime() : Infinity;

    if (isDriving) {
        await updateDrivingTelematics(orgId, updated.drivingSessionId, user, lat, lng, speedMph);
    }

    if (isDriving || sinceLastHistory >= HISTORY_THROTTLE_MS) {
        LocationHistory.create({
            userId: user._id,
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
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { reason } = req.body as { reason?: 'manual' | 'break' };
    const sharingState = reason === 'break' ? 'paused_break' : 'paused_manual';

    const existing = await EmployeeLocation.findOne({ userId: user._id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === sharingState;

    await EmployeeLocation.findOneAndUpdate(
        { userId: user._id },
        { organizationId: orgId, sharingState },
        { upsert: true },
    );

    if (alreadySet) {
        res.json(new ApiResponse(200, { sharingState }, 'Location sharing paused'));
        return;
    }

    emitToOrg(orgId, 'locator:sharing_state_changed', { userId: user._id.toString(), sharingState });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        userAvatar: user.avatar,
        type: 'location_sharing_paused',
        description: `${user.name} paused location sharing`,
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { sharingState }, 'Location sharing paused'));
});

const resumeSharing = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;

    if (!user.locationConsent?.granted) {
        throw new ApiError(403, 'Location sharing is not enabled for this account');
    }

    const existing = await EmployeeLocation.findOne({ userId: user._id }).select('sharingState').lean();
    const alreadySet = existing?.sharingState === 'sharing';

    const updated = await EmployeeLocation.findOneAndUpdate(
        { userId: user._id },
        { organizationId: orgId, sharingState: 'sharing' },
        { upsert: true, new: true },
    );

    if (alreadySet) {
        res.json(new ApiResponse(200, { sharingState: updated.sharingState }, 'Location sharing resumed'));
        return;
    }

    emitToOrg(orgId, 'locator:sharing_state_changed', { userId: user._id.toString(), sharingState: updated.sharingState });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        userAvatar: user.avatar,
        type: 'location_sharing_resumed',
        description: `${user.name} resumed location sharing`,
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { sharingState: updated.sharingState }, 'Location sharing resumed'));
});

const getActiveEmployeeLocations = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    // Visible to everyone in the dealership — the live map is a team-wide tool.
    const locations = await EmployeeLocation.find({ organizationId: orgId })
        .populate('userId', 'name avatar personalInfo.jobTitle employmentLocationType')
        .lean();

    const result = locations
        .filter((l: any) => l.userId)
        .map((l: any) => ({
            userId: l.userId._id,
            userName: l.userId.name,
            userAvatar: l.userId.avatar,
            jobTitle: l.userId.personalInfo?.jobTitle,
            employmentLocationType: l.userId.employmentLocationType,
            coords: l.coords,
            heading: l.heading,
            speedMph: l.speedMph,
            sharingState: l.sharingState,
            batteryLevel: l.batteryLevel,
            isCharging: l.isCharging,
            connectivity: l.connectivity,
            currentPlaceId: l.currentPlaceId,
            lastSeenAt: l.lastSeenAt,
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
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
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
        createdBy: user._id,
    });

    emitToOrg(orgId, 'locator:place_created', { place });
    res.json(new ApiResponse(201, place, 'Place created'));
});

const updatePlace = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
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
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isAdmin) throw new ApiError(403, 'Only admins can delete places');

    const place = await Place.findOneAndUpdate({ _id: id, organizationId: orgId }, { isActive: false });
    if (!place) throw new ApiError(404, 'Place not found');

    emitToOrg(orgId, 'locator:place_deleted', { placeId: id });
    res.json(new ApiResponse(200, null, 'Place deleted'));
});

const manualCheckIn = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const place = await Place.findOne({ _id: id, organizationId: orgId, isActive: true });
    if (!place) throw new ApiError(404, 'Place not found');

    const visit = await PlaceVisit.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        placeId: place._id,
        placeName: place.name,
        enteredAt: new Date(),
        method: 'manual_checkin',
    });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        userAvatar: user.avatar,
        type: 'geofence_enter',
        description: `${user.name} checked in at ${place.name}`,
        meta: { placeId: place._id, placeName: place.name, method: 'manual_checkin' },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:place_entered', {
        userId: user._id.toString(), userName: user.name,
        placeId: place._id, placeName: place.name, enteredAt: visit.enteredAt,
    });

    res.json(new ApiResponse(201, visit, 'Checked in'));
});

// ── History & reporting ──────────────────────────────────────────────────────

const getLocationHistory = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { userId } = req.params;
    const { from, to } = req.query as { from?: string; to?: string };

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    const isSelf = user._id.toString() === userId;
    if (!isAdmin && !isSelf) throw new ApiError(403, 'Not authorized to view this history');

    const query: any = { organizationId: orgId, userId };
    if (from || to) {
        query.recordedAt = {};
        if (from) query.recordedAt.$gte = new Date(from);
        if (to) query.recordedAt.$lte = new Date(to);
    }

    const history = await LocationHistory.find(query).sort({ recordedAt: 1 }).limit(2000).lean();
    res.json(new ApiResponse(200, history, 'Location history fetched'));
});

const getTimeAtPlaceReport = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { from, to, userId, placeId } = req.query as { from?: string; to?: string; userId?: string; placeId?: string };

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
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

// ── Driving sessions ─────────────────────────────────────────────────────────

const getDrivingSessions = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { userId, from, to } = req.query as { userId?: string; from?: string; to?: string };
    const isAdmin = ['admin', 'super_admin'].includes(user.role);

    const query: any = { organizationId: orgId };
    if (userId) {
        if (!isAdmin && userId !== user._id.toString()) throw new ApiError(403, 'Not authorized');
        query.userId = userId;
    } else if (!isAdmin) {
        query.userId = user._id;
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
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const isAdmin = ['admin', 'super_admin'].includes(user.role);

    const session = await DrivingSession.findOne({ _id: id, organizationId: orgId }).lean();
    if (!session) throw new ApiError(404, 'Driving session not found');
    if (!isAdmin && session.userId.toString() !== user._id.toString()) throw new ApiError(403, 'Not authorized');

    const route = await LocationHistory.find({ drivingSessionId: id }).sort({ recordedAt: 1 }).lean();
    res.json(new ApiResponse(200, { session, route }, 'Driving session detail fetched'));
});

const respondToIncident = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { confirmed } = req.body as { confirmed: boolean };

    const session = await DrivingSession.findOne({ _id: id, organizationId: orgId });
    if (!session) throw new ApiError(404, 'Driving session not found');
    if (session.userId.toString() !== user._id.toString()) throw new ApiError(403, 'Not authorized');
    if (!session.possibleIncident) throw new ApiError(400, 'No incident to respond to');

    session.possibleIncident.confirmed = confirmed;
    session.possibleIncident.respondedAt = new Date();
    await session.save();

    emitToOrg(orgId, 'locator:incident_resolved', { sessionId: session._id, confirmed });

    if (confirmed) {
        notifyAdmins(orgId, {
            title: '🚨 Incident Confirmed',
            body: `${user.name} confirmed an incident during a test drive`,
            tag: `locator-incident-confirmed-${session._id}`,
            data: { url: '/team-pulse?tab=activity' },
        });
    }

    res.json(new ApiResponse(200, session, 'Incident response recorded'));
});

// ── SOS ───────────────────────────────────────────────────────────────────────

const triggerSos = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { lat, lng } = req.body as { lat: number; lng: number };
    if (typeof lat !== 'number' || typeof lng !== 'number') throw new ApiError(400, 'lat and lng are required');

    const alert = await SosAlert.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        coords: { lat, lng },
        status: 'active',
    });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        userAvatar: user.avatar,
        type: 'sos_triggered',
        description: `${user.name} triggered an SOS alert`,
        meta: { sosId: alert._id, coords: alert.coords },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:sos_triggered', {
        sosId: alert._id, userId: user._id.toString(), userName: user.name,
        coords: alert.coords, createdAt: alert.createdAt,
    });

    notifyAdmins(orgId, {
        title: '🆘 SOS Alert',
        body: `${user.name} triggered an SOS alert — respond immediately`,
        tag: `locator-sos-${alert._id}`,
        data: { url: '/team-pulse?tab=activity' },
    });

    res.json(new ApiResponse(201, alert, 'SOS alert triggered'));
});

const resolveSos = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { status, note } = req.body as { status: 'resolved' | 'false_alarm'; note?: string };
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isAdmin) throw new ApiError(403, 'Only admins can resolve SOS alerts');

    const alert = await SosAlert.findOne({ _id: id, organizationId: orgId });
    if (!alert) throw new ApiError(404, 'SOS alert not found');

    alert.status = status === 'false_alarm' ? 'false_alarm' : 'resolved';
    alert.resolvedBy = user._id;
    alert.resolvedAt = new Date();
    alert.resolutionNote = note;
    await alert.save();

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId: alert.userId,
        userName: alert.userName,
        type: 'sos_resolved',
        description: `${alert.userName}'s SOS alert was ${alert.status === 'false_alarm' ? 'marked as a false alarm' : 'resolved'} by ${user.name}`,
        meta: { sosId: alert._id },
    });
    emitToOrg(orgId, 'activity:new', event);
    emitToOrg(orgId, 'locator:sos_resolved', { sosId: alert._id, status: alert.status, resolvedBy: user.name });

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
    ingestLocation, pauseSharing, resumeSharing, getActiveEmployeeLocations,
    getPlaces, createPlace, updatePlace, deletePlace, manualCheckIn,
    getLocationHistory, getTimeAtPlaceReport,
    getDrivingSessions, getDrivingSessionDetail, respondToIncident,
    triggerSos, resolveSos, getActiveSosAlerts,
};
