import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';
import ProjectGroup, { IProjectGroup } from '../models/ProjectGroup.model';
import ProjectSection from '../models/ProjectSection.model';
import ProjectFolder from '../models/ProjectFolder.model';
import ProjectTask, {
  IProjectAttachment,
  PROJECT_TASK_STATUSES,
  ProjectTaskStatus,
  PROJECT_TASK_PRIORITIES,
  ProjectTaskPriority,
} from '../models/ProjectTask.model';
import ProjectTaskComment from '../models/ProjectTaskComment.model';
import { syncTaskToCalendar, removeTaskCalendarEvent } from '../services/projectCalendarSync.service';
import ProjectNotification, { ProjectNotificationType } from '../models/ProjectNotification.model';
import { BucketType, storageService } from '../services/storage.service';
import { getSocketIO } from '../utils/socketEmitter';
import notificationService from '../services/notification.service';
import logger from '../utils/logger';

// Maps Project Management's own notification vocabulary onto the unified
// Notification system's namespaced pm_* types.
const UNIFIED_PM_TYPE_MAP: Record<ProjectNotificationType, string> = {
  task_assigned: 'pm_task_assigned',
  task_comment: 'pm_task_comment',
  task_status: 'pm_task_status',
  task_updated: 'pm_task_updated',
  group_added: 'pm_group_added',
  task_mention: 'pm_task_mention',
  task_deadline: 'pm_task_deadline',
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMBER_SEARCH_LIMIT = 20;
const COMMENT_PAGE_LIMIT = 50;
const R2_FOLDER = 'project-attachments'; // same private R2 bucket flow as DayPulse

// ─── Small utilities ──────────────────────────────────────────────────────────

const oid = (id: string) => new mongoose.Types.ObjectId(id);

function assertObjectId(id: string, label = 'ID') {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, `Invalid ${label}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safe display name for notification text and author snapshots. The synthetic
 * admin user created by crmAuth for main-app Bearer tokens may not carry a
 * fullName, and authorName/actorName are required fields.
 */
function displayNameOf(user: any): string {
  return user?.fullName || user?.username || user?.email || 'Team member';
}

/**
 * Sign private-bucket attachment keys into time-limited URLs before sending
 * to the client. Identical approach to DayPulse.signAttachments.
 */
async function signAttachments<T extends { attachments?: IProjectAttachment[] }>(doc: T): Promise<T> {
  if (!Array.isArray(doc.attachments) || doc.attachments.length === 0) return doc;

  await Promise.all(doc.attachments.map(async (attachment) => {
    const signedUrl = await storageService.getSignedUrl(attachment.fileKey || attachment.url);
    if (signedUrl) {
      attachment.url = signedUrl;
      if (attachment.thumbnailUrl) attachment.thumbnailUrl = signedUrl;
    }
  }));

  return doc;
}

/**
 * Upload multer files to R2 (private bucket) and return the attachment
 * records plus the raw keys (for rollback on failure).
 */
async function uploadAttachments(
  files: Express.Multer.File[],
  uploadedBy: mongoose.Types.ObjectId,
): Promise<{ attachments: IProjectAttachment[]; uploadedKeys: string[] }> {
  const attachments: IProjectAttachment[] = [];
  const uploadedKeys: string[] = [];

  for (const file of files) {
    const fileUrl = await storageService.upload(file, R2_FOLDER, BucketType.PRIVATE);
    const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
    uploadedKeys.push(fileKey);

    const isImage = file.mimetype.startsWith('image/');
    attachments.push({
      url: fileKey,
      fileKey,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      thumbnailUrl: isImage ? fileKey : undefined,
      uploadedBy,
      createdAt: new Date(),
    });
  }

  return { attachments, uploadedKeys };
}

async function rollbackUploads(keys: string[]) {
  await Promise.all(keys.map((key) =>
    storageService.delete(key, BucketType.PRIVATE).catch(() => undefined),
  ));
}

// ─── Access control ───────────────────────────────────────────────────────────

/**
 * Central gate for the whole module. Loads a live group scoped to the actor's
 * organization AND verifies the actor is a member. Non-members receive a 404
 * (not 403) so that group existence is never leaked to outsiders.
 */
async function loadGroupForMember(groupId: string, actor: any): Promise<IProjectGroup> {
  assertObjectId(groupId, 'group ID');
  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization to use Project Management');
  }

  const group = await ProjectGroup.findOne({
    _id: groupId,
    organizationId: actor.organizationId,
    deletedAt: null,
  });

  if (!group) throw new ApiError(404, 'Project group not found');

  const actorId = actor._id.toString();
  const isMember = group.memberIds.some((m) => m.toString() === actorId);
  if (!isMember) throw new ApiError(404, 'Project group not found'); // deliberate: don't reveal existence

  return group;
}

// ─── Real-time + notifications ────────────────────────────────────────────────

/**
 * Emit an event to each group member's private socket room (`user:{id}`).
 * Uses per-user rooms (already established by the tray/CRM socket handshake)
 * instead of an org-wide room, so events never reach non-members.
 */
function emitToMembers(memberIds: mongoose.Types.ObjectId[], event: string, payload: unknown) {
  try {
    const io = getSocketIO();
    if (!io) return;
    for (const memberId of memberIds) {
      io.to(`user:${memberId.toString()}`).emit(event, payload);
    }
  } catch (error) {
    console.error('[PM] socket emit failed:', error);
  }
}

interface NotifyArgs {
  recipients: Array<mongoose.Types.ObjectId | string | null | undefined>;
  actor: any;
  type: ProjectNotificationType;
  groupId: mongoose.Types.ObjectId;
  taskId?: mongoose.Types.ObjectId | null;
  title: string;
  message: string;
  commentId?: mongoose.Types.ObjectId | null;
}

/**
 * Create per-user notifications (deduped, never notifying the actor about
 * their own action) and push a `pm:notification` socket event so the sidebar
 * badge updates in real time.
 */
async function notifyUsers({ recipients, actor, type, groupId, taskId, commentId, title, message }: NotifyArgs) {
  const actorId = actor._id.toString();
  const uniqueRecipients = Array.from(new Set(
    recipients
      .filter(Boolean)
      .map((r) => r!.toString())
      .filter((r) => r !== actorId),
  ));

  if (uniqueRecipients.length === 0) return;

  try {
    const docs = await ProjectNotification.insertMany(
      uniqueRecipients.map((userId) => ({
        organizationId: actor.organizationId,
        userId: oid(userId),
        type,
        groupId,
        taskId: taskId ?? null,
        commentId: commentId ?? null,
        actorId: actor._id,
        actorName: displayNameOf(actor),
        title,
        message,
      })),
    );

    try {
      const io = getSocketIO();
      if (io) {
        for (const doc of docs) {
          io.to(`user:${doc.userId.toString()}`).emit('pm:notification', {
            _id: doc._id,
            type: doc.type,
            title: doc.title,
            message: doc.message,
            groupId: doc.groupId,
            taskId: doc.taskId,
            commentId: (doc as any).commentId ?? null,
            actorName: doc.actorName,
            createdAt: doc.createdAt,
          });
        }
      }
    } catch { /* socket not initialised — REST flow unaffected */ }

    // Best-effort fan-out into the unified bell/page/push system.
    await Promise.allSettled(
      uniqueRecipients.map((userId) =>
        notificationService.createNotification({
          userId,
          organizationId: actor.organizationId.toString(),
          type: UNIFIED_PM_TYPE_MAP[type],
          title,
          message,
          metadata: {
            groupId: groupId?.toString(),
            taskId: taskId ? taskId.toString() : undefined,
            commentId: commentId ? commentId.toString() : undefined,
            route: '/crm/project',
          },
        }).catch((error) => logger.error(error, `[PM] Unified notification failed for recipient ${userId}`))
      ),
    );
  } catch (error) {
    // Notifications are best-effort; never fail the primary request over them.
    console.error('[PM] failed to create notifications:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MEMBER SEARCH (org-scoped)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/crm/projects/members/search?q=...
 *
 * Returns active, non-offboarded CrmUsers of the actor's organization ONLY.
 * Used by the group-member picker and the task assignee picker.
 */
export const searchMembers = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  const filter: Record<string, unknown> = {
    organizationId: actor.organizationId, // hard org boundary — never relaxed
    isActive: true,
    isOffboarded: { $ne: true },
    isSystem: { $ne: true },
  };

  if (q) {
    const escaped = escapeRegex(q);
    filter.$or = [
      { fullName: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
      { username: { $regex: escaped, $options: 'i' } },
    ];
  }

  const users = await CrmUser.find(filter)
    .select('fullName username email avatar role department')
    .sort({ fullName: 1 })
    .limit(MEMBER_SEARCH_LIMIT)
    .lean();

  res.json(new ApiResponse(200, { users }, 'Members fetched'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  PROJECT GROUPS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/crm/projects/groups
 * Body: { name, description?, memberIds: string[] }
 */
export const createGroup = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const { name, description, memberIds } = req.body as {
    name?: string; description?: string; memberIds?: string[];
  };

  if (!name?.trim()) throw new ApiError(400, 'Group name is required');

  const requestedIds: string[] = Array.isArray(memberIds) ? memberIds : [];
  requestedIds.forEach((id) => assertObjectId(id, 'member ID'));

  // Only accept members that actually exist INSIDE the actor's organization.
  // Any foreign / unknown IDs are silently dropped — cross-org membership is
  // impossible by construction.
  const validMembers = requestedIds.length > 0
    ? await CrmUser.find({
        _id: { $in: requestedIds.map(oid) },
        organizationId: actor.organizationId,
        isActive: true,
        isSystem: { $ne: true },
      }).select('_id').lean()
    : [];

  const finalMemberIds = Array.from(new Set([
    actor._id.toString(), // creator is always a member
    ...validMembers.map((u) => u._id.toString()),
  ])).map(oid);

  const group = await ProjectGroup.create({
    organizationId: actor.organizationId,
    name: name.trim(),
    description: description?.trim() || '',
    createdBy: actor._id,
    memberIds: finalMemberIds,
  });

  await notifyUsers({
    recipients: finalMemberIds,
    actor,
    type: 'group_added',
    groupId: group._id as mongoose.Types.ObjectId,
    title: 'Added to a project group',
    message: `${displayNameOf(actor)} added you to "${group.name}"`,
  });

  emitToMembers(finalMemberIds, 'pm:group:new', { group });

  res.status(201).json(new ApiResponse(201, { group }, 'Project group created'));
});

/**
 * GET /api/crm/projects/groups
 * Only groups the actor is a member of. Non-member groups are invisible.
 */
export const getGroups = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const groups = await ProjectGroup.find({
    organizationId: actor.organizationId,
    memberIds: actor._id,
    deletedAt: null,
  })
    .populate('memberIds', 'fullName username email avatar role')
    .sort({ updatedAt: -1 })
    .lean();

  res.json(new ApiResponse(200, { groups }, 'Project groups fetched'));
});

/**
 * PATCH /api/crm/projects/groups/:groupId
 * Body: { name?, description?, memberIds? } — creator or org admin only.
 */
export const updateGroup = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const group = await loadGroupForMember(req.params.groupId, actor);

  const isCreator = group.createdBy.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isCreator && !isAdmin) {
    throw new ApiError(403, 'Only the group creator or an admin can edit this group');
  }

  const { name, description, memberIds } = req.body as {
    name?: string; description?: string; memberIds?: string[];
  };

  if (name?.trim()) group.name = name.trim();
  if (description !== undefined) group.description = description?.trim() || '';

  let addedMemberIds: mongoose.Types.ObjectId[] = [];
  if (Array.isArray(memberIds)) {
    memberIds.forEach((id) => assertObjectId(id, 'member ID'));

    const validMembers = await CrmUser.find({
      _id: { $in: memberIds.map(oid) },
      organizationId: actor.organizationId, // org boundary again
      isSystem: { $ne: true },
    }).select('_id').lean();

    const previous = new Set(group.memberIds.map((m) => m.toString()));
    const next = Array.from(new Set([
      group.createdBy.toString(), // creator cannot be removed
      ...validMembers.map((u) => u._id.toString()),
    ]));

    addedMemberIds = next.filter((id) => !previous.has(id)).map(oid);
    group.memberIds = next.map(oid);
  }

  await group.save();

  if (addedMemberIds.length > 0) {
    await notifyUsers({
      recipients: addedMemberIds,
      actor,
      type: 'group_added',
      groupId: group._id as mongoose.Types.ObjectId,
      title: 'Added to a project group',
      message: `${displayNameOf(actor)} added you to "${group.name}"`,
    });
  }

  emitToMembers(group.memberIds, 'pm:group:updated', { group });

  res.json(new ApiResponse(200, { group }, 'Project group updated'));
});

/**
 * DELETE /api/crm/projects/groups/:groupId — creator or org admin only.
 * Soft delete; children stay in place under the tombstoned group.
 */
export const deleteGroup = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const group = await loadGroupForMember(req.params.groupId, actor);

  const isCreator = group.createdBy.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isCreator && !isAdmin) {
    throw new ApiError(403, 'Only the group creator or an admin can delete this group');
  }

  group.deletedAt = new Date();
  await group.save();

  emitToMembers(group.memberIds, 'pm:group:deleted', { groupId: group._id });

  res.json(new ApiResponse(200, { groupId: group._id }, 'Project group deleted'));
});

/**
 * GET /api/crm/projects/groups/:groupId/tree
 *
 * Returns the full hierarchy (sections → folders → task summaries) in three
 * indexed queries so the workspace renders with one round-trip.
 */
export const getGroupTree = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const group = await loadGroupForMember(req.params.groupId, actor);

  const [sections, folders, tasks, members] = await Promise.all([
    ProjectSection.find({ groupId: group._id, deletedAt: null })
      .sort({ order: 1, createdAt: 1 }).lean(),
    ProjectFolder.find({ groupId: group._id, deletedAt: null })
      .sort({ order: 1, createdAt: 1 }).lean(),
    ProjectTask.find({ groupId: group._id, deletedAt: null })
      .select('title status priority assigneeIds createdBy startDate deadline folderId sectionId commentCount attachments seenBy order createdAt updatedAt')
      .sort({ createdAt: -1 }).lean(), // latest task always first
    CrmUser.find({ _id: { $in: group.memberIds }, organizationId: actor.organizationId })
      .select('fullName username email avatar role').lean(),
  ]);

  // Task summaries only need the attachment COUNT — strip keys, don't sign.
  // unseenForMe: the viewer is involved (creator/assignee) and hasn't opened
  // the task since its last activity — drives the unread highlight.
  const meId = actor._id.toString();
  const taskSummaries = tasks.map((t: any) => {
    const involved = t.createdBy?.toString() === meId
      || (t.assigneeIds || []).some((a: any) => a.toString() === meId);
    const seen = (t.seenBy || []).some((u: any) => u.toString() === meId);
    return {
      ...t,
      attachmentCount: Array.isArray(t.attachments) ? t.attachments.length : 0,
      attachments: undefined,
      seenBy: undefined,
      unseenForMe: involved && !seen,
    };
  });

  res.json(new ApiResponse(200, {
    group,
    members,
    sections,
    folders,
    tasks: taskSummaries,
  }, 'Project group tree fetched'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  SECTIONS
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/crm/projects/groups/:groupId/sections — any group member. */
export const createSection = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const group = await loadGroupForMember(req.params.groupId, actor);

  const { name } = req.body as { name?: string };
  if (!name?.trim()) throw new ApiError(400, 'Section name is required');

  const last = await ProjectSection.findOne({ groupId: group._id, deletedAt: null })
    .sort({ order: -1 }).select('order').lean();

  const section = await ProjectSection.create({
    organizationId: actor.organizationId,
    groupId: group._id,
    name: name.trim(),
    createdBy: actor._id,
    order: (last?.order ?? -1) + 1,
  });

  emitToMembers(group.memberIds, 'pm:section:new', { groupId: group._id, section });

  res.status(201).json(new ApiResponse(201, { section }, 'Section created'));
});

/** PATCH /api/crm/projects/sections/:sectionId — any group member (rename / reorder). */
export const updateSection = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.sectionId, 'section ID');

  const section = await ProjectSection.findOne({ _id: req.params.sectionId, deletedAt: null });
  if (!section) throw new ApiError(404, 'Section not found');

  const group = await loadGroupForMember(section.groupId.toString(), actor);

  const { name, order } = req.body as { name?: string; order?: number };
  if (name?.trim()) section.name = name.trim();
  if (typeof order === 'number') section.order = order;
  await section.save();

  emitToMembers(group.memberIds, 'pm:section:updated', { groupId: group._id, section });

  res.json(new ApiResponse(200, { section }, 'Section updated'));
});

/** DELETE /api/crm/projects/sections/:sectionId — section creator, group creator, or admin. */
export const deleteSection = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.sectionId, 'section ID');

  const section = await ProjectSection.findOne({ _id: req.params.sectionId, deletedAt: null });
  if (!section) throw new ApiError(404, 'Section not found');

  const group = await loadGroupForMember(section.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canDelete = section.createdBy.toString() === actorId
    || group.createdBy.toString() === actorId
    || actor.role === 'admin';
  if (!canDelete) throw new ApiError(403, 'You do not have permission to delete this section');

  section.deletedAt = new Date();
  await section.save();

  emitToMembers(group.memberIds, 'pm:section:deleted', { groupId: group._id, sectionId: section._id });

  res.json(new ApiResponse(200, { sectionId: section._id }, 'Section deleted'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  FOLDER GROUPS
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/crm/projects/sections/:sectionId/folders — any group member. */
export const createFolder = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.sectionId, 'section ID');

  const section = await ProjectSection.findOne({ _id: req.params.sectionId, deletedAt: null });
  if (!section) throw new ApiError(404, 'Section not found');

  const group = await loadGroupForMember(section.groupId.toString(), actor);

  const { name } = req.body as { name?: string };
  if (!name?.trim()) throw new ApiError(400, 'Folder name is required');

  const last = await ProjectFolder.findOne({ sectionId: section._id, deletedAt: null })
    .sort({ order: -1 }).select('order').lean();

  const folder = await ProjectFolder.create({
    organizationId: actor.organizationId,
    groupId: group._id,
    sectionId: section._id,
    name: name.trim(),
    createdBy: actor._id,
    order: (last?.order ?? -1) + 1,
  });

  emitToMembers(group.memberIds, 'pm:folder:new', { groupId: group._id, folder });

  res.status(201).json(new ApiResponse(201, { folder }, 'Folder created'));
});

/** PATCH /api/crm/projects/folders/:folderId — any group member (rename / reorder). */
export const updateFolder = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.folderId, 'folder ID');

  const folder = await ProjectFolder.findOne({ _id: req.params.folderId, deletedAt: null });
  if (!folder) throw new ApiError(404, 'Folder not found');

  const group = await loadGroupForMember(folder.groupId.toString(), actor);

  const { name, order } = req.body as { name?: string; order?: number };
  if (name?.trim()) folder.name = name.trim();
  if (typeof order === 'number') folder.order = order;
  await folder.save();

  emitToMembers(group.memberIds, 'pm:folder:updated', { groupId: group._id, folder });

  res.json(new ApiResponse(200, { folder }, 'Folder updated'));
});

/** DELETE /api/crm/projects/folders/:folderId — folder creator, group creator, or admin. */
export const deleteFolder = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.folderId, 'folder ID');

  const folder = await ProjectFolder.findOne({ _id: req.params.folderId, deletedAt: null });
  if (!folder) throw new ApiError(404, 'Folder not found');

  const group = await loadGroupForMember(folder.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canDelete = folder.createdBy.toString() === actorId
    || group.createdBy.toString() === actorId
    || actor.role === 'admin';
  if (!canDelete) throw new ApiError(403, 'You do not have permission to delete this folder');

  folder.deletedAt = new Date();
  await folder.save();

  emitToMembers(group.memberIds, 'pm:folder:deleted', { groupId: group._id, folderId: folder._id });

  res.json(new ApiResponse(200, { folderId: folder._id }, 'Folder deleted'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  TASKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize `assigneeIds` from JSON or multipart bodies into a validated,
 * deduped ObjectId array. Multipart forms deliver repeated fields as either
 * a string or a string[]; JSON clients may send an array or a JSON-encoded
 * string. Every ID must belong to the group's members (which are themselves
 * org-scoped), otherwise the request is rejected.
 */
function parseAssigneeIds(raw: unknown, group: IProjectGroup): mongoose.Types.ObjectId[] {
  if (raw === undefined || raw === null || raw === '') return [];

  let ids: string[];
  if (Array.isArray(raw)) {
    ids = raw.map(String);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        ids = Array.isArray(parsed) ? parsed.map(String) : [trimmed];
      } catch {
        ids = [trimmed];
      }
    } else {
      ids = [trimmed];
    }
  } else {
    throw new ApiError(400, 'assigneeIds must be an array of member IDs');
  }

  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  const memberSet = new Set(group.memberIds.map((m) => m.toString()));

  for (const id of unique) {
    assertObjectId(id, 'assignee ID');
    if (!memberSet.has(id)) {
      throw new ApiError(400, 'Every assignee must be a member of this project group');
    }
  }

  return unique.map(oid);
}

/** Validates and normalizes an incoming priority value; '' / undefined clears it. */
function parsePriority(raw: unknown): ProjectTaskPriority | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (!PROJECT_TASK_PRIORITIES.includes(raw as ProjectTaskPriority)) {
    throw new ApiError(400, `priority must be one of: ${PROJECT_TASK_PRIORITIES.join(', ')}, or empty to clear`);
  }
  return raw as ProjectTaskPriority;
}

/**
 * POST /api/crm/projects/folders/:folderId/tasks   (multipart)
 * Fields: title, description?, assigneeIds[]?, startDate?, deadline?, status?, priority?
 * Files:  attachments[] (same R2 private-bucket flow as DayPulse)
 */
export const createTask = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.folderId, 'folder ID');

  const folder = await ProjectFolder.findOne({ _id: req.params.folderId, deletedAt: null });
  if (!folder) throw new ApiError(404, 'Folder not found');

  const group = await loadGroupForMember(folder.groupId.toString(), actor);

  const { title, description, startDate, deadline, status, priority } = req.body as {
    title?: string; description?: string;
    startDate?: string; deadline?: string; status?: string; priority?: string;
  };

  if (!title?.trim()) throw new ApiError(400, 'Task title is required');

  let taskStatus: ProjectTaskStatus = 'todo';
  if (status) {
    if (!PROJECT_TASK_STATUSES.includes(status as ProjectTaskStatus)) {
      throw new ApiError(400, `status must be one of: ${PROJECT_TASK_STATUSES.join(', ')}`);
    }
    taskStatus = status as ProjectTaskStatus;
  }

  const taskPriority = parsePriority(priority) ?? 'normal';

  // Every assignee must be a member of THIS group (which itself is org-scoped).
  const assigneeIds = parseAssigneeIds(req.body.assigneeIds, group);

  const parsedStart = startDate ? new Date(startDate) : null;
  const parsedDeadline = deadline ? new Date(deadline) : null;
  if (parsedStart && isNaN(parsedStart.getTime())) throw new ApiError(400, 'Invalid start date');
  if (parsedDeadline && isNaN(parsedDeadline.getTime())) throw new ApiError(400, 'Invalid deadline');
  if (parsedStart && parsedDeadline && parsedDeadline < parsedStart) {
    throw new ApiError(400, 'Deadline cannot be before the start date');
  }

  const files = (req.files as Express.Multer.File[] | undefined) || [];
  const { attachments, uploadedKeys } = await uploadAttachments(files, actor._id);

  try {
    const last = await ProjectTask.findOne({ folderId: folder._id, deletedAt: null })
      .sort({ order: -1 }).select('order').lean();

    const task = await ProjectTask.create({
      organizationId: actor.organizationId,
      groupId: group._id,
      sectionId: folder.sectionId,
      folderId: folder._id,
      title: title.trim(),
      description: description?.trim() || '',
      status: taskStatus,
      priority: taskPriority,
      createdBy: actor._id,
      assigneeIds,
      startDate: parsedStart,
      deadline: parsedDeadline,
      attachments,
      order: (last?.order ?? -1) + 1,
      completedAt: taskStatus === 'completed' ? new Date() : null,
      seenBy: [actor._id], // fresh task is unseen for everyone but its creator
    });

    // Deadline → Suprah Calendar (best-effort; never fails the create).
    if (task.deadline) {
      const eventId = await syncTaskToCalendar(task, actor._id);
      if (eventId) {
        task.calendarEventId = eventId;
        await ProjectTask.updateOne({ _id: task._id }, { $set: { calendarEventId: eventId } });
      }
    }

    if (assigneeIds.length > 0) {
      await notifyUsers({
        recipients: assigneeIds,
        actor,
        type: 'task_assigned',
        groupId: group._id as mongoose.Types.ObjectId,
        taskId: task._id as mongoose.Types.ObjectId,
        title: 'New task assigned to you',
        message: `${displayNameOf(actor)} assigned you "${task.title}" in ${group.name}`,
      });
    }

    const taskForClient = await signAttachments(task.toObject());
    emitToMembers(group.memberIds, 'pm:task:new', { groupId: group._id, task: taskForClient });

    res.status(201).json(new ApiResponse(201, { task: taskForClient }, 'Task created'));
  } catch (error) {
    await rollbackUploads(uploadedKeys);
    throw error;
  }
});

/** GET /api/crm/projects/tasks/:taskId — full detail with signed attachment URLs. */
export const getTask = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null })
    .populate('assigneeIds', 'fullName username email avatar')
    .populate('createdBy', 'fullName username email avatar');
  if (!task) throw new ApiError(404, 'Task not found');

  await loadGroupForMember(task.groupId.toString(), actor); // membership gate

  // Opening the task acknowledges its latest activity for this viewer.
  await ProjectTask.updateOne({ _id: task._id }, { $addToSet: { seenBy: actor._id } });

  const taskForClient = await signAttachments(task.toObject());

  res.json(new ApiResponse(200, { task: taskForClient }, 'Task fetched'));
});

/**
 * PATCH /api/crm/projects/tasks/:taskId
 * Edits title / description / assignees / dates. Permitted: task creator,
 * any current assignee, or org admin. (Status is NOT editable here — see below.)
 */
export const updateTask = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null });
  if (!task) throw new ApiError(404, 'Task not found');

  const group = await loadGroupForMember(task.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canEdit = task.createdBy.toString() === actorId
    || task.assigneeIds.some((a) => a.toString() === actorId)
    || actor.role === 'admin';
  if (!canEdit) throw new ApiError(403, 'Only the task creator or an assignee can edit this task');

  const { title, description, startDate, deadline, priority } = req.body as {
    title?: string; description?: string;
    startDate?: string | null; deadline?: string | null; priority?: string | null;
  };

  if (title !== undefined) {
    if (!title?.trim()) throw new ApiError(400, 'Task title cannot be empty');
    task.title = title.trim();
  }
  if (description !== undefined) task.description = description?.trim() || '';

  const nextPriority = parsePriority(priority);
  if (nextPriority !== undefined) task.priority = nextPriority;

  // Replace the assignee set; only members NEW to the task get the
  // "assigned to you" notification.
  let newlyAssigned: mongoose.Types.ObjectId[] = [];
  if (req.body.assigneeIds !== undefined) {
    const nextAssignees = parseAssigneeIds(req.body.assigneeIds, group);
    const previous = new Set(task.assigneeIds.map((a) => a.toString()));
    newlyAssigned = nextAssignees.filter((a) => !previous.has(a.toString()));
    task.assigneeIds = nextAssignees;
  }

  if (startDate !== undefined) {
    const d = startDate ? new Date(startDate) : null;
    if (d && isNaN(d.getTime())) throw new ApiError(400, 'Invalid start date');
    task.startDate = d;
  }
  if (deadline !== undefined) {
    const d = deadline ? new Date(deadline) : null;
    if (d && isNaN(d.getTime())) throw new ApiError(400, 'Invalid deadline');
    task.deadline = d;
  }
  if (task.startDate && task.deadline && task.deadline < task.startDate) {
    throw new ApiError(400, 'Deadline cannot be before the start date');
  }

  // A moved deadline re-arms the reminder windows.
  if (task.isModified('deadline')) task.remindersSent = [];
  // Edits reset seen-tracking: the task is "unseen" again for everyone else.
  task.seenBy = [actor._id];

  await task.save();

  // Keep the linked Suprah Calendar event in lockstep (best-effort).
  const syncedEventId = await syncTaskToCalendar(task, actor._id);
  if (syncedEventId !== task.calendarEventId) {
    task.calendarEventId = syncedEventId;
    await ProjectTask.updateOne({ _id: task._id }, { $set: { calendarEventId: syncedEventId } });
  }

  if (newlyAssigned.length > 0) {
    await notifyUsers({
      recipients: newlyAssigned,
      actor,
      type: 'task_assigned',
      groupId: group._id as mongoose.Types.ObjectId,
      taskId: task._id as mongoose.Types.ObjectId,
      title: 'New task assigned to you',
      message: `${displayNameOf(actor)} assigned you "${task.title}" in ${group.name}`,
    });
  }

  // Keep the creator and every assignee informed of edits they didn't make.
  await notifyUsers({
    recipients: [task.createdBy, ...task.assigneeIds],
    actor,
    type: 'task_updated',
    groupId: group._id as mongoose.Types.ObjectId,
    taskId: task._id as mongoose.Types.ObjectId,
    title: 'Task updated',
    message: `${displayNameOf(actor)} updated "${task.title}"`,
  });

  const taskForClient = await signAttachments(task.toObject());
  emitToMembers(group.memberIds, 'pm:task:updated', { groupId: group._id, task: taskForClient });

  res.json(new ApiResponse(200, { task: taskForClient }, 'Task updated'));
});

/**
 * PATCH /api/crm/projects/tasks/:taskId/status
 *
 * STRICT permission rule (enforced here, on the backend, per spec):
 * ONLY the task creator or the assigned user may change the workflow status.
 * Org admins and other group members get a 403 — they can view, not move.
 */
export const updateTaskStatus = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const { status } = req.body as { status?: string };
  if (!status || !PROJECT_TASK_STATUSES.includes(status as ProjectTaskStatus)) {
    throw new ApiError(400, `status must be one of: ${PROJECT_TASK_STATUSES.join(', ')}`);
  }

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null });
  if (!task) throw new ApiError(404, 'Task not found');

  const group = await loadGroupForMember(task.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canChangeStatus = task.createdBy.toString() === actorId
    || task.assigneeIds.some((a) => a.toString() === actorId);
  if (!canChangeStatus) {
    throw new ApiError(403, 'Only the task creator or an assigned user can change the status');
  }

  const previousStatus = task.status;
  task.status = status as ProjectTaskStatus;
  task.completedAt = status === 'completed' ? new Date() : null;
  task.seenBy = [actor._id]; // status change is new activity for everyone else
  await task.save();

  // Reflect the status on the linked calendar event (best-effort).
  await syncTaskToCalendar(task, actor._id);

  if (previousStatus !== task.status) {
    await notifyUsers({
      recipients: [task.createdBy, ...task.assigneeIds],
      actor,
      type: 'task_status',
      groupId: group._id as mongoose.Types.ObjectId,
      taskId: task._id as mongoose.Types.ObjectId,
      title: 'Task status changed',
      message: `${displayNameOf(actor)} moved "${task.title}" to ${task.status}`,
    });
  }

  emitToMembers(group.memberIds, 'pm:task:status', {
    groupId: group._id,
    taskId: task._id,
    status: task.status,
    previousStatus,
    changedBy: actorId,
  });

  res.json(new ApiResponse(200, { taskId: task._id, status: task.status }, 'Status updated'));
});

/** DELETE /api/crm/projects/tasks/:taskId — task creator, group creator, or admin. */
export const deleteTask = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null });
  if (!task) throw new ApiError(404, 'Task not found');

  const group = await loadGroupForMember(task.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canDelete = task.createdBy.toString() === actorId
    || group.createdBy.toString() === actorId
    || actor.role === 'admin';
  if (!canDelete) throw new ApiError(403, 'You do not have permission to delete this task');

  // Best-effort cleanup of R2 objects (task + comment attachments stay
  // recoverable only until this point — matches DayPulse delete behaviour).
  if (task.attachments.length > 0) {
    await rollbackUploads(task.attachments.map((a) => a.fileKey || a.url));
  }

  task.deletedAt = new Date();
  await task.save();

  // Remove the linked Suprah Calendar event (best-effort).
  await removeTaskCalendarEvent(task);

  emitToMembers(group.memberIds, 'pm:task:deleted', { groupId: group._id, taskId: task._id });

  res.json(new ApiResponse(200, { taskId: task._id }, 'Task deleted'));
});

/**
 * POST /api/crm/projects/tasks/:taskId/attachments   (multipart)
 * Files: attachments[] (up to 10 per request, 25 MB each — same multer
 * config as createTask). Lets the creator/assignee/admin add files to a task
 * after the fact, not just at creation time.
 */
export const addTaskAttachments = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (files.length === 0) throw new ApiError(400, 'No files were uploaded');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null });
  if (!task) throw new ApiError(404, 'Task not found');

  const group = await loadGroupForMember(task.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canEdit = task.createdBy.toString() === actorId
    || task.assigneeIds.some((a) => a.toString() === actorId)
    || actor.role === 'admin';
  if (!canEdit) throw new ApiError(403, 'Only the task creator or an assignee can add attachments');

  if (task.attachments.length + files.length > 30) {
    throw new ApiError(400, 'A task can hold at most 30 attachments');
  }

  const { attachments, uploadedKeys } = await uploadAttachments(files, actor._id);

  try {
    task.attachments.push(...attachments);
    task.seenBy = [actor._id];
    await task.save();
  } catch (error) {
    await rollbackUploads(uploadedKeys);
    throw error;
  }

  await notifyUsers({
    recipients: [task.createdBy, ...task.assigneeIds],
    actor,
    type: 'task_updated',
    groupId: group._id as mongoose.Types.ObjectId,
    taskId: task._id as mongoose.Types.ObjectId,
    title: 'Task updated',
    message: `${displayNameOf(actor)} added ${attachments.length > 1 ? `${attachments.length} attachments` : 'an attachment'} to "${task.title}"`,
  });

  const taskForClient = await signAttachments(task.toObject());
  emitToMembers(group.memberIds, 'pm:task:updated', { groupId: group._id, task: taskForClient });

  res.status(201).json(new ApiResponse(201, { task: taskForClient }, 'Attachments added'));
});

/**
 * DELETE /api/crm/projects/tasks/:taskId/attachments/:attachmentId
 * Removes a single attachment from a task (creator, assignee, or admin) and
 * deletes the underlying R2 object.
 */
export const deleteTaskAttachment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');
  assertObjectId(req.params.attachmentId, 'attachment ID');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null });
  if (!task) throw new ApiError(404, 'Task not found');

  const group = await loadGroupForMember(task.groupId.toString(), actor);

  const actorId = actor._id.toString();
  const canEdit = task.createdBy.toString() === actorId
    || task.assigneeIds.some((a) => a.toString() === actorId)
    || actor.role === 'admin';
  if (!canEdit) throw new ApiError(403, 'Only the task creator or an assignee can remove attachments');

  const attachment = (task.attachments as any[]).find((a) => a._id?.toString() === req.params.attachmentId);
  if (!attachment) throw new ApiError(404, 'Attachment not found');

  task.attachments = (task.attachments as any[]).filter(
    (a) => a._id?.toString() !== req.params.attachmentId,
  ) as typeof task.attachments;
  await task.save();

  await storageService.delete(attachment.fileKey || attachment.url, BucketType.PRIVATE).catch(() => undefined);

  const taskForClient = await signAttachments(task.toObject());
  emitToMembers(group.memberIds, 'pm:task:updated', { groupId: group._id, task: taskForClient });

  res.json(new ApiResponse(200, { task: taskForClient }, 'Attachment removed'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  TASK COMMENTS
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/crm/projects/tasks/:taskId/comments?page=1 */
export const getComments = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null })
    .select('groupId').lean();
  if (!task) throw new ApiError(404, 'Task not found');

  await loadGroupForMember(task.groupId.toString(), actor);

  const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
  const skip = (page - 1) * COMMENT_PAGE_LIMIT;

  const [comments, total] = await Promise.all([
    ProjectTaskComment.find({ taskId: req.params.taskId, deletedAt: null })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(COMMENT_PAGE_LIMIT)
      .lean(),
    ProjectTaskComment.countDocuments({ taskId: req.params.taskId, deletedAt: null }),
  ]);

  const commentsForClient = await Promise.all(
    (comments as Array<Record<string, any>>).map((c) => signAttachments(c)),
  );

  res.json(new ApiResponse(200, {
    comments: commentsForClient,
    total,
    page,
    hasMore: skip + comments.length < total,
  }, 'Comments fetched'));
});

/**
 * POST /api/crm/projects/tasks/:taskId/comments   (multipart)
 * Fields: message. Files: attachments[]. Any group member may comment.
 * Notifies the task creator and assignee (excluding the commenter).
 */
export const addComment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.taskId, 'task ID');

  const task = await ProjectTask.findOne({ _id: req.params.taskId, deletedAt: null });
  if (!task) throw new ApiError(404, 'Task not found');

  const group = await loadGroupForMember(task.groupId.toString(), actor);

  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const files = (req.files as Express.Multer.File[] | undefined) || [];

  if (!message && files.length === 0) {
    throw new ApiError(400, 'Comment must contain a message or at least one attachment');
  }

  // @-mentions: ids resolved by the composer's picker. Only group members
  // count — anything else is silently dropped (same policy as assignees).
  const memberSet = new Set(group.memberIds.map((m) => m.toString()));
  const mentionIds = parseAssigneeIds(req.body.mentions, group)
    .filter((id) => memberSet.has(id.toString()));

  const { attachments, uploadedKeys } = await uploadAttachments(files, actor._id);

  try {
    const comment = await ProjectTaskComment.create({
      organizationId: actor.organizationId,
      groupId: group._id,
      taskId: task._id,
      userId: actor._id,
      authorName: displayNameOf(actor),
      authorAvatar: actor.avatar || null,
      authorRole: actor.role,
      message,
      mentions: mentionIds,
      attachments,
    });

    task.commentCount += 1;
    task.seenBy = [actor._id]; // a new comment is fresh activity for everyone else
    await task.save();

    // Mentioned users get the specific, deep-linkable mention notification…
    if (mentionIds.length > 0) {
      await notifyUsers({
        recipients: mentionIds,
        actor,
        type: 'task_mention',
        groupId: group._id as mongoose.Types.ObjectId,
        taskId: task._id as mongoose.Types.ObjectId,
        commentId: comment._id as mongoose.Types.ObjectId,
        title: 'You were mentioned',
        message: `${displayNameOf(actor)} mentioned you in "${task.title}"`,
      });
    }

    // …and everyone else involved gets the generic comment notification
    // (mentioned users are excluded so nobody is notified twice).
    const mentionedSet = new Set(mentionIds.map((m) => m.toString()));
    await notifyUsers({
      recipients: [task.createdBy, ...task.assigneeIds]
        .filter((r) => r && !mentionedSet.has(r.toString())),
      actor,
      type: 'task_comment',
      groupId: group._id as mongoose.Types.ObjectId,
      taskId: task._id as mongoose.Types.ObjectId,
      commentId: comment._id as mongoose.Types.ObjectId,
      title: 'New comment on your task',
      message: `${displayNameOf(actor)} commented on "${task.title}"`,
    });

    const commentForClient = await signAttachments(comment.toObject());
    emitToMembers(group.memberIds, 'pm:comment:new', {
      groupId: group._id,
      taskId: task._id,
      comment: commentForClient,
      commentCount: task.commentCount,
    });

    res.status(201).json(new ApiResponse(201, { comment: commentForClient }, 'Comment added'));
  } catch (error) {
    await rollbackUploads(uploadedKeys);
    throw error;
  }
});

/**
 * PATCH /api/crm/projects/comments/:commentId — comment author ONLY (no admin
 * override — you can only edit what you wrote). Body: { message, mentions? }.
 */
export const updateComment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.commentId, 'comment ID');

  const comment = await ProjectTaskComment.findOne({ _id: req.params.commentId, deletedAt: null });
  if (!comment) throw new ApiError(404, 'Comment not found');

  if (comment.userId.toString() !== actor._id.toString()) {
    throw new ApiError(403, 'You can only edit your own comments');
  }

  const group = await loadGroupForMember(comment.groupId.toString(), actor);

  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message && comment.attachments.length === 0) {
    throw new ApiError(400, 'Comment must contain a message or at least one attachment');
  }

  const memberSet = new Set(group.memberIds.map((m) => m.toString()));
  const mentionIds = req.body.mentions !== undefined
    ? parseAssigneeIds(req.body.mentions, group).filter((id) => memberSet.has(id.toString()))
    : comment.mentions;

  comment.message = message;
  comment.mentions = mentionIds;
  comment.isEdited = true;
  await comment.save();

  const commentForClient = await signAttachments(comment.toObject());
  emitToMembers(group.memberIds, 'pm:comment:updated', {
    groupId: group._id,
    taskId: comment.taskId,
    comment: commentForClient,
  });

  res.json(new ApiResponse(200, { comment: commentForClient }, 'Comment updated'));
});

/** DELETE /api/crm/projects/comments/:commentId — comment author or admin. */
export const deleteComment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  assertObjectId(req.params.commentId, 'comment ID');

  const comment = await ProjectTaskComment.findOne({ _id: req.params.commentId, deletedAt: null });
  if (!comment) throw new ApiError(404, 'Comment not found');

  const group = await loadGroupForMember(comment.groupId.toString(), actor);

  const canDelete = comment.userId.toString() === actor._id.toString() || actor.role === 'admin';
  if (!canDelete) throw new ApiError(403, 'You can only delete your own comments');

  if (comment.attachments.length > 0) {
    await rollbackUploads(comment.attachments.map((a) => a.fileKey || a.url));
  }

  comment.deletedAt = new Date();
  await comment.save();

  await ProjectTask.updateOne(
    { _id: comment.taskId },
    { $inc: { commentCount: -1 } },
  );

  emitToMembers(group.memberIds, 'pm:comment:deleted', {
    groupId: group._id,
    taskId: comment.taskId,
    commentId: comment._id,
  });

  res.json(new ApiResponse(200, { commentId: comment._id }, 'Comment deleted'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  MENTIONS INBOX (cross-group, paginated)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/crm/projects/mentions?page=1&limit=15
 *
 * Every comment the actor was @-mentioned in, newest first, joined with the
 * project group name, task title, and author — powers the "Mentions" tab.
 * Scoped to live groups the actor is still a member of.
 */
export const getMentions = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 15, 1), 50);
  const skip = (page - 1) * limit;

  const memberGroups = await ProjectGroup.find({
    organizationId: actor.organizationId,
    memberIds: actor._id,
    deletedAt: null,
  }).select('_id name').lean();
  const groupIds = memberGroups.map((g) => g._id);
  const groupNames = new Map(memberGroups.map((g) => [g._id.toString(), g.name]));

  const filter = {
    groupId: { $in: groupIds },
    mentions: actor._id,
    deletedAt: null,
  };

  const [comments, total] = await Promise.all([
    ProjectTaskComment.find(filter)
      .select('taskId groupId userId authorName authorAvatar message createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ProjectTaskComment.countDocuments(filter),
  ]);

  // Join task titles (live tasks only — mentions on deleted tasks drop out).
  const taskIds = Array.from(new Set(comments.map((c: any) => c.taskId.toString())));
  const tasks = taskIds.length > 0
    ? await ProjectTask.find({ _id: { $in: taskIds.map(oid) }, deletedAt: null })
        .select('title status folderId').lean()
    : [];
  const taskById = new Map(tasks.map((t: any) => [t._id.toString(), t]));

  const items = comments
    .filter((c: any) => taskById.has(c.taskId.toString()))
    .map((c: any) => {
      const t = taskById.get(c.taskId.toString());
      return {
        commentId: c._id,
        taskId: c.taskId,
        groupId: c.groupId,
        groupName: groupNames.get(c.groupId.toString()) || '',
        taskTitle: t?.title || '',
        taskStatus: t?.status,
        mentionedBy: c.authorName,
        mentionedByAvatar: c.authorAvatar || null,
        preview: (c.message || '').slice(0, 140),
        createdAt: c.createdAt,
      };
    });

  res.json(new ApiResponse(200, {
    mentions: items,
    total,
    page,
    limit,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  }, 'Mentions fetched'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  MY TASKS (cross-group, paginated)
// ═══════════════════════════════════════════════════════════════════════════

const MY_TASKS_DEFAULT_LIMIT = 10;
const MY_TASKS_MAX_LIMIT = 50;

/**
 * GET /api/crm/projects/my-tasks?view=active|completed&page=1&limit=10
 *
 * Paginated, cross-group list of the actor's tasks (assigned to them OR
 * created by them), newest first.
 *   view=active     → every status EXCEPT 'completed' (the "My Tasks" panel)
 *   view=completed  → only 'completed' (the "Completed Tasks" panel)
 *
 * Org/group isolation: tasks are only pulled from live groups the actor is
 * still a member of, so leaving (or being removed from) a group also removes
 * its tasks from these lists.
 */
const MY_TASKS_SORT_FIELDS = ['createdAt', 'deadline', 'title', 'group', 'priority'] as const;
const PRIORITY_RANK: Record<ProjectTaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
type MyTasksSortField = typeof MY_TASKS_SORT_FIELDS[number];

export const getMyTasks = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const view = req.query.view === 'completed' ? 'completed' : 'active';
  const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit as string, 10) || MY_TASKS_DEFAULT_LIMIT, 1),
    MY_TASKS_MAX_LIMIT,
  );
  const skip = (page - 1) * limit;

  const sortByRaw = req.query.sortBy as string;
  const sortBy: MyTasksSortField = MY_TASKS_SORT_FIELDS.includes(sortByRaw as MyTasksSortField)
    ? (sortByRaw as MyTasksSortField)
    : 'createdAt';
  // Dates default newest-first; title/group/priority default ascending
  // (priority "ascending" means urgent → low, per PRIORITY_RANK).
  const sortDirDefault = sortBy === 'title' || sortBy === 'group' || sortBy === 'priority' ? 1 : -1;
  const sortDir = req.query.sortDir === 'asc' ? 1 : req.query.sortDir === 'desc' ? -1 : sortDirDefault;

  // Live groups the actor is a member of (org-scoped) — the visibility fence.
  const memberGroups = await ProjectGroup.find({
    organizationId: actor.organizationId,
    memberIds: actor._id,
    deletedAt: null,
  }).select('_id name').lean();

  const groupIds = memberGroups.map((g) => g._id);
  const groupNames = new Map(memberGroups.map((g) => [g._id.toString(), g.name]));

  const filter: Record<string, unknown> = {
    groupId: { $in: groupIds },
    deletedAt: null,
    $or: [{ assigneeIds: actor._id }, { createdBy: actor._id }],
    status: view === 'completed' ? 'completed' : { $ne: 'completed' },
  };

  // "deadline"/"title"/"group" sorts need in-memory handling: deadline must
  // push null/missing values to the end regardless of direction, and "group"
  // sorts by a name that only exists in `groupNames` (not on the task doc).
  // The candidate set is already bounded by the standard pagination window
  // fetched a page ahead-of-time isn't feasible without an aggregation, so we
  // fetch the full filtered set (still org+actor scoped, realistically small)
  // sorted by createdAt, re-sort in JS, then slice the requested page.
  const needsJsSort = sortBy !== 'createdAt';

  const baseQuery = ProjectTask.find(filter)
    .select('title status priority assigneeIds createdBy startDate deadline groupId sectionId folderId commentCount attachments seenBy completedAt createdAt')
    .populate('assigneeIds', 'fullName username avatar')
    .sort({ createdAt: -1 });

  let tasks: any[];
  let total: number;

  if (needsJsSort) {
    const [allTasks, count] = await Promise.all([
      baseQuery.lean(),
      ProjectTask.countDocuments(filter),
    ]);
    total = count;

    const compare = (a: any, b: any): number => {
      if (sortBy === 'deadline') {
        const aTime = a.deadline ? new Date(a.deadline).getTime() : null;
        const bTime = b.deadline ? new Date(b.deadline).getTime() : null;
        if (aTime === null && bTime === null) return 0;
        if (aTime === null) return 1; // no deadline always sinks to the end
        if (bTime === null) return -1;
        return (aTime - bTime) * sortDir;
      }
      if (sortBy === 'title') {
        return a.title.localeCompare(b.title) * sortDir;
      }
      if (sortBy === 'priority') {
        const aRank = PRIORITY_RANK[a.priority as ProjectTaskPriority] ?? PRIORITY_RANK.normal;
        const bRank = PRIORITY_RANK[b.priority as ProjectTaskPriority] ?? PRIORITY_RANK.normal;
        return (aRank - bRank) * sortDir;
      }
      // group
      const aName = groupNames.get(a.groupId.toString()) || '';
      const bName = groupNames.get(b.groupId.toString()) || '';
      return aName.localeCompare(bName) * sortDir;
    };

    allTasks.sort(compare);
    tasks = allTasks.slice(skip, skip + limit);
  } else {
    const [pageTasks, count] = await Promise.all([
      baseQuery.sort({ createdAt: sortDir }).skip(skip).limit(limit).lean(),
      ProjectTask.countDocuments(filter),
    ]);
    tasks = pageTasks;
    total = count;
  }

  // Folder names for "Group · Folder" context lines (one indexed query).
  const folderIds = Array.from(new Set(
    tasks.map((t: any) => t.folderId?.toString()).filter(Boolean),
  ));
  const folders = folderIds.length > 0
    ? await ProjectFolder.find({ _id: { $in: folderIds.map(oid) } }).select('name').lean()
    : [];
  const folderNames = new Map(folders.map((f: any) => [f._id.toString(), f.name]));

  const meId = actor._id.toString();
  const items = tasks.map((t: any) => ({
    ...t,
    attachmentCount: Array.isArray(t.attachments) ? t.attachments.length : 0,
    attachments: undefined, // counts only — keys are never exposed in lists
    seenBy: undefined,
    unseenForMe: !(t.seenBy || []).some((u: any) => u.toString() === meId),
    groupName: groupNames.get(t.groupId.toString()) || '',
    folderName: folderNames.get(t.folderId?.toString()) || '',
  }));

  res.json(new ApiResponse(200, {
    tasks: items,
    total,
    page,
    limit,
    totalPages: Math.max(Math.ceil(total / limit), 1),
    hasMore: skip + tasks.length < total,
  }, 'My tasks fetched'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS (sidebar badge)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/crm/projects/notifications/count — unread count for the badge. */
export const getNotificationCount = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const count = await ProjectNotification.countDocuments({
    userId: actor._id,
    readAt: null,
  });

  res.json(new ApiResponse(200, { count }, 'Unread notification count'));
});

/** GET /api/crm/projects/notifications?limit=30 — recent notifications, newest first. */
export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 30, 1), 100);

  const notifications = await ProjectNotification.find({ userId: actor._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(new ApiResponse(200, { notifications }, 'Notifications fetched'));
});

/**
 * POST /api/crm/projects/notifications/read
 * Body: { ids?: string[] } — marks the given notifications read, or ALL of
 * the actor's unread notifications when `ids` is omitted.
 */
export const markNotificationsRead = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { ids } = req.body as { ids?: string[] };

  const filter: Record<string, unknown> = { userId: actor._id, readAt: null };
  if (Array.isArray(ids) && ids.length > 0) {
    ids.forEach((id) => assertObjectId(id, 'notification ID'));
    filter._id = { $in: ids.map(oid) };
  }

  const result = await ProjectNotification.updateMany(filter, { $set: { readAt: new Date() } });

  res.json(new ApiResponse(200, { modified: result.modifiedCount }, 'Notifications marked read'));
});

export default {
  searchMembers,
  createGroup,
  getGroups,
  updateGroup,
  deleteGroup,
  getGroupTree,
  createSection,
  updateSection,
  deleteSection,
  createFolder,
  updateFolder,
  deleteFolder,
  createTask,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  addTaskAttachments,
  deleteTaskAttachment,
  getComments,
  addComment,
  updateComment,
  deleteComment,
  getMyTasks,
  getMentions,
  getNotificationCount,
  getNotifications,
  markNotificationsRead,
};