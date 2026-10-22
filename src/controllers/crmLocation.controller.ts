import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import {
  LOCATION_LIMITS,
  createLocation,
  listLocationAudit,
  listLocations,
  loadLocation,
  locationAccess,
  setLocationArchived,
  suggestLocationLabels,
  updateLocation,
} from '../services/crmLocation.service';

function context(req: Request): { orgId: string; user: any } {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  return { orgId, user };
}

function requireViewer(req: Request) {
  const ctx = context(req);
  if (locationAccess(ctx.user) === 'none') throw new ApiError(403, 'Only managers and admins can view locations');
  return ctx;
}

function requireAdmin(req: Request) {
  const ctx = context(req);
  if (locationAccess(ctx.user) !== 'admin') throw new ApiError(403, 'Only admins can change locations');
  return ctx;
}

function serializeLocation(location: any) {
  return {
    id: String(location._id),
    code: location.code,
    name: location.name,
    aliases: location.aliases || [],
    status: location.status,
    archivedAt: location.archivedAt || undefined,
    revision: location.revision,
    createdByName: location.createdBy?.name,
    updatedByName: location.updatedBy?.name,
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
  };
}

function serializeAudit(row: any) {
  return {
    id: String(row._id),
    action: row.action,
    revision: row.revision,
    before: row.before || undefined,
    after: row.after,
    actorName: row.actor?.name,
    actorRole: row.actor?.role,
    createdAt: row.createdAt,
  };
}

export const getLocations = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = requireViewer(req);
  const raw = String(req.query.status || 'active');
  if (!['active', 'archived', 'all'].includes(raw)) throw new ApiError(400, 'status must be active, archived or all');
  const { locations, counts } = await listLocations(orgId, raw as 'active' | 'archived' | 'all');
  res.json(new ApiResponse(200, {
    locations: locations.map(serializeLocation),
    counts,
    limits: { perOrg: LOCATION_LIMITS.perOrg, aliases: LOCATION_LIMITS.aliases, name: LOCATION_LIMITS.name, alias: LOCATION_LIMITS.alias, code: LOCATION_LIMITS.code },
    canManage: locationAccess(user) === 'admin',
  }, 'Locations'));
});

export const getLocationSuggestions = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = requireViewer(req);
  res.json(new ApiResponse(200, { suggestions: await suggestLocationLabels(orgId) }, 'Location suggestions'));
});

export const getLocation = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = requireViewer(req);
  const location = await loadLocation(orgId, String(req.params.id));
  const audit = await listLocationAudit(orgId, location._id);
  res.json(new ApiResponse(200, { location: serializeLocation(location.toObject()), history: audit.map(serializeAudit) }, 'Location'));
});

export const createLocationHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = requireAdmin(req);
  const location = await createLocation({ organizationId: orgId, user, location: req.body?.location });
  res.status(201).json(new ApiResponse(201, { location: serializeLocation(location.toObject()) }, 'Location created'));
});

export const updateLocationHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = requireAdmin(req);
  const { location, changed } = await updateLocation({
    organizationId: orgId, user, id: String(req.params.id), location: req.body?.location, expectedRevision: req.body?.expectedRevision,
  });
  res.json(new ApiResponse(200, { location: serializeLocation(location.toObject()), changed }, changed ? 'Location updated' : 'No changes'));
});

function archiveHandler(archived: boolean) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { orgId, user } = requireAdmin(req);
    const location = await setLocationArchived({
      organizationId: orgId, user, id: String(req.params.id), archived, expectedRevision: req.body?.expectedRevision,
    });
    res.json(new ApiResponse(200, { location: serializeLocation(location.toObject()) }, archived ? 'Location archived' : 'Location restored'));
  });
}

export const archiveLocationHandler = archiveHandler(true);
export const restoreLocationHandler = archiveHandler(false);
