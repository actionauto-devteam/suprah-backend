import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import EmployeeOfMonth from '../models/EmployeeOfMonth.model';
import EotmTeam, { IEotmTeam } from '../models/EotmTeam.model';
import EotmNomination from '../models/EotmNomination.model';
import EotmKudos, { EOTM_KUDOS_REACTIONS } from '../models/EotmKudos.model';
import CrmUser from '../models/CrmUser.model';
import notificationService from '../services/notification.service';
import { CALENDAR_TZ } from '../constants/calendarTimezone';

function requireActor(req: Request) {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization');
  }
  return actor;
}

function requireAdmin(req: Request) {
  const actor = requireActor(req);
  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can manage Employee of the Month');
  }
  return actor;
}

// The dealership's own calendar day/month, not the server's — matches the
// convention already used for calendar reminders (see calendarTimezone.ts).
// Without this, a server clock in UTC rolls "current month" over to the 1st
// hours before it's actually the 1st in Utah/Philippines.
function currentMonth(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CALENDAR_TZ }).slice(0, 7);
}

async function loadTeam(organizationId: mongoose.Types.ObjectId, teamId: unknown) {
  if (typeof teamId !== 'string' || !mongoose.Types.ObjectId.isValid(teamId)) return null;
  return EotmTeam.findOne({ _id: teamId, organizationId });
}

// Filters to well-formed ObjectId strings AND confirms each one is actually a
// CrmUser within this organization — without the org check, a team's roster
// (and everywhere that trusts it, like getCandidates) could be made to
// reference another dealership's employee.
async function sanitizeMemberIds(organizationId: mongoose.Types.ObjectId, memberIds: unknown): Promise<string[]> {
  const candidateIds = Array.isArray(memberIds)
    ? memberIds.filter((id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id))
    : [];
  if (candidateIds.length === 0) return [];
  const validUsers = await CrmUser.find({ _id: { $in: candidateIds }, organizationId }).select('_id').lean();
  const validIds = new Set(validUsers.map((u) => u._id.toString()));
  return candidateIds.filter((id) => validIds.has(id));
}

// ---- Teams ----

export const listTeams = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const includeInactive = req.query.includeInactive === 'true' && actor.role === 'admin';
  const filter: Record<string, unknown> = { organizationId: actor.organizationId };
  if (!includeInactive) filter.isActive = true;

  const teams = await EotmTeam.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  res.json(
    new ApiResponse(
      200,
      {
        teams: teams.map((t) => ({
          _id: t._id,
          name: t.name,
          color: t.color,
          isActive: t.isActive,
          sortOrder: t.sortOrder,
          memberCount: t.memberIds?.length || 0,
          memberIds: t.memberIds,
        })),
      },
      'Teams fetched',
    ),
  );
});

export const createTeam = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const { name, color, memberIds } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ApiError(400, 'Team name is required');
  }

  const maxSort = await EotmTeam.findOne({ organizationId: actor.organizationId })
    .sort({ sortOrder: -1 })
    .select('sortOrder')
    .lean();

  let team: IEotmTeam;
  try {
    team = await EotmTeam.create({
      organizationId: actor.organizationId,
      name: name.trim(),
      color: typeof color === 'string' && color ? color : 'amber',
      memberIds: await sanitizeMemberIds(actor.organizationId, memberIds),
      createdBy: actor._id,
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
    });
  } catch (err: any) {
    if (err?.code === 11000) throw new ApiError(409, 'A team with this name already exists');
    throw err;
  }

  res.status(201).json(new ApiResponse(201, team, 'Team created'));
});

export const updateTeam = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const team = await loadTeam(actor.organizationId, req.params.teamId);
  if (!team) throw new ApiError(404, 'Team not found');

  const { name, color, isActive, memberIds } = req.body;
  if (typeof name === 'string' && name.trim()) team.name = name.trim();
  if (typeof color === 'string' && color) team.color = color;
  if (typeof isActive === 'boolean') team.isActive = isActive;
  if (Array.isArray(memberIds)) team.memberIds = (await sanitizeMemberIds(actor.organizationId, memberIds)) as any;

  try {
    await team.save();
  } catch (err: any) {
    if (err?.code === 11000) throw new ApiError(409, 'A team with this name already exists');
    throw err;
  }

  res.json(new ApiResponse(200, team, 'Team updated'));
});

// ---- Current winners / candidates / set winner ----

export const getCurrent = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const month = currentMonth();

  const [teams, rows] = await Promise.all([
    EotmTeam.find({ organizationId: actor.organizationId, isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    EmployeeOfMonth.find({ organizationId: actor.organizationId, month })
      .populate('employeeId', 'fullName username avatar role department')
      .lean(),
  ]);

  // Guard against pre-migration records that predate the teamId schema (a
  // stray legacy doc with no teamId must never take down the whole endpoint
  // — it just won't attach to any team card).
  const byTeam = new Map(rows.filter((row) => row.teamId).map((row) => [row.teamId.toString(), row]));

  res.json(
    new ApiResponse(
      200,
      {
        month,
        teams: teams.map((team) => {
          const row = byTeam.get(team._id.toString());
          return {
            teamId: team._id,
            name: team.name,
            color: team.color,
            memberCount: team.memberIds?.length || 0,
            winnerId: row?._id || null,
            employee: row ? row.employeeId : null,
            note: row?.note || null,
            setAt: row?.updatedAt || null,
          };
        }),
      },
      'Employee of the month fetched',
    ),
  );
});

export const getCandidates = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { teamId, q } = req.query;

  const team = await loadTeam(actor.organizationId, teamId);
  if (!team) throw new ApiError(400, 'A valid team is required');

  const filter: Record<string, unknown> = {
    _id: { $in: team.memberIds },
    organizationId: actor.organizationId,
    isActive: true,
  };
  const query = typeof q === 'string' ? q.trim() : '';
  if (query) {
    filter.fullName = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const users = await CrmUser.find(filter)
    .select('fullName username avatar role department')
    .sort({ fullName: 1 })
    .limit(50)
    .lean();

  res.json(new ApiResponse(200, { users }, 'Candidates fetched'));
});

export const setWinner = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const { teamId, employeeId, note } = req.body;

  const team = await loadTeam(actor.organizationId, teamId);
  if (!team) throw new ApiError(400, 'A valid team is required');
  if (!employeeId || typeof employeeId !== 'string') {
    throw new ApiError(400, 'employeeId is required');
  }
  if (!team.memberIds.some((id) => id.toString() === employeeId)) {
    throw new ApiError(404, 'Employee is not a member of that team');
  }

  const employee = await CrmUser.findOne({ _id: employeeId, organizationId: actor.organizationId }).select(
    'fullName username avatar role department',
  );
  if (!employee) throw new ApiError(404, 'Employee not found');

  const month = currentMonth();

  const row = await EmployeeOfMonth.findOneAndUpdate(
    { organizationId: actor.organizationId, teamId: team._id, month },
    {
      employeeId: employee._id,
      note: typeof note === 'string' ? note.trim().slice(0, 280) : undefined,
      setByUserId: actor._id,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const recipientIds = team.memberIds.map((id) => id.toString()).filter((id) => id !== actor._id.toString());
  if (recipientIds.length > 0) {
    notificationService
      .createNotificationBatch(
        recipientIds.map((userId) => ({
          userId,
          organizationId: actor.organizationId.toString(),
          type: 'eotm_winner_announced',
          title: 'Employee of the Month',
          message: `${employee.fullName} was named ${team.name} Employee of the Month for ${month}!`,
          metadata: { teamId: team._id.toString(), employeeId: employee._id.toString(), month },
        })),
      )
      .catch((err) => console.error('[EOTM] Failed to send winner notifications:', err));
  }

  res.json(
    new ApiResponse(
      200,
      { month, teamId: team._id, winnerId: row._id, employee, note: row.note || null, setAt: row.updatedAt },
      'Employee of the month updated',
    ),
  );
});

// Takes teamId as a route param, not a DELETE body — some proxies/load
// balancers (this app deploys behind AWS Elastic Beanstalk) strip bodies off
// DELETE requests, which would make this silently unusable in production.
export const clearWinner = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const team = await loadTeam(actor.organizationId, req.params.teamId);
  if (!team) throw new ApiError(400, 'A valid team is required');

  const month = currentMonth();
  const row = await EmployeeOfMonth.findOneAndDelete({
    organizationId: actor.organizationId,
    teamId: team._id,
    month,
  });
  if (row) {
    await EotmKudos.deleteMany({ winnerId: row._id });
  }

  res.json(new ApiResponse(200, { month, teamId: team._id }, 'Employee of the month cleared'));
});

// ---- History / stats ----

export const getHistory = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { teamId, year } = req.query;
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '24'), 10) || 24));

  const monthFilter: Record<string, unknown> = { $lt: currentMonth() };
  if (typeof year === 'string' && /^\d{4}$/.test(year)) {
    monthFilter.$regex = `^${year}-`;
  }

  const filter: Record<string, unknown> = {
    organizationId: actor.organizationId,
    month: monthFilter,
  };
  if (typeof teamId === 'string' && mongoose.Types.ObjectId.isValid(teamId)) {
    filter.teamId = teamId;
  }

  const [rows, total, allMonths]: [any[], number, string[]] = await Promise.all([
    EmployeeOfMonth.find(filter)
      .populate('employeeId', 'fullName username avatar role department')
      .populate('setByUserId', 'fullName username')
      .populate('teamId', 'name color')
      .sort({ month: -1, createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EmployeeOfMonth.countDocuments(filter),
    EmployeeOfMonth.distinct('month', { organizationId: actor.organizationId }),
  ]);

  const availableYears = Array.from(
    new Set(allMonths.filter((m) => m < currentMonth()).map((m) => m.slice(0, 4))),
  ).sort((a, b) => b.localeCompare(a));

  const items = rows.map((row) => ({
    _id: row._id,
    month: row.month,
    teamId: row.teamId?._id || row.teamId,
    teamName: row.teamId?.name || 'Unknown team',
    teamColor: row.teamId?.color,
    employee: row.employeeId,
    note: row.note || null,
    setAt: row.updatedAt,
    setBy: row.setByUserId,
  }));

  res.json(
    new ApiResponse(
      200,
      { items, page, hasMore: page * limit < total, availableYears },
      'Employee of the month history fetched',
    ),
  );
});

// Deletes any single Employee of the Month record (current or historical) by
// id — covers cleaning up a mistaken/test pick from a past month, which
// clearWinner can't reach since it only ever targets the current month, and
// also covers pre-migration legacy records that have no teamId to match on.
export const deleteHistoryEntry = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const row = await EmployeeOfMonth.findOneAndDelete({
    _id: req.params.id,
    organizationId: actor.organizationId,
  });
  if (!row) throw new ApiError(404, 'Record not found');
  await EotmKudos.deleteMany({ winnerId: row._id });
  res.json(new ApiResponse(200, {}, 'Record removed'));
});

export const getStats = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { teamId } = req.query;

  const match: Record<string, unknown> = { organizationId: actor.organizationId };
  if (typeof teamId === 'string' && mongoose.Types.ObjectId.isValid(teamId)) {
    match.teamId = new mongoose.Types.ObjectId(teamId);
  }

  const rows = await EmployeeOfMonth.aggregate([
    { $match: match },
    { $group: { _id: '$employeeId', wins: { $sum: 1 }, lastWin: { $max: '$month' } } },
    { $sort: { wins: -1, lastWin: -1 } },
    { $limit: 20 },
  ]);

  const employees = await CrmUser.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('fullName avatar department')
    .lean();
  const byId = new Map(employees.map((e) => [e._id.toString(), e]));

  const leaderboard = rows.map((r) => ({
    employee: byId.get(r._id.toString()) || null,
    wins: r.wins,
    lastWin: r.lastWin,
  }));

  res.json(new ApiResponse(200, { leaderboard }, 'Employee of the month stats fetched'));
});

// ---- Nominations ----

export const listNominations = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const { teamId } = req.query;
  if (typeof teamId !== 'string' || !mongoose.Types.ObjectId.isValid(teamId)) {
    throw new ApiError(400, 'A valid team is required');
  }

  const nominations = await EotmNomination.find({
    organizationId: actor.organizationId,
    teamId,
    month: currentMonth(),
    status: 'pending',
  })
    .populate('nomineeId', 'fullName avatar')
    .populate('submittedBy', 'fullName avatar')
    .sort({ createdAt: -1 })
    .lean();

  res.json(new ApiResponse(200, { nominations }, 'Nominations fetched'));
});

export const createNomination = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { teamId, nomineeId, note } = req.body;

  const team = await loadTeam(actor.organizationId, teamId);
  if (!team) throw new ApiError(400, 'A valid team is required');
  if (!nomineeId || typeof nomineeId !== 'string' || !team.memberIds.some((id) => id.toString() === nomineeId)) {
    throw new ApiError(400, 'Nominee must be a member of that team');
  }

  const month = currentMonth();
  const existing = await EotmNomination.findOne({
    organizationId: actor.organizationId,
    teamId: team._id,
    month,
    nomineeId,
    submittedBy: actor._id,
    status: 'pending',
  });
  if (existing) {
    throw new ApiError(409, "You've already nominated this person this month");
  }

  const nomination = await EotmNomination.create({
    organizationId: actor.organizationId,
    teamId: team._id,
    month,
    nomineeId,
    submittedBy: actor._id,
    note: typeof note === 'string' ? note.trim().slice(0, 500) : undefined,
  });

  res.status(201).json(new ApiResponse(201, nomination, 'Nomination submitted'));
});

export const dismissNomination = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdmin(req);
  const nomination = await EotmNomination.findOneAndUpdate(
    { _id: req.params.id, organizationId: actor.organizationId },
    { status: 'dismissed' },
    { new: true },
  );
  if (!nomination) throw new ApiError(404, 'Nomination not found');
  res.json(new ApiResponse(200, nomination, 'Nomination dismissed'));
});

// ---- Kudos ----

export const getKudos = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { winnerId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(winnerId)) throw new ApiError(400, 'Invalid winner id');

  const winner = await EmployeeOfMonth.findOne({ _id: winnerId, organizationId: actor.organizationId }).select('_id');
  if (!winner) throw new ApiError(404, 'Winner not found');

  const kudos = await EotmKudos.find({ winnerId }).sort({ createdAt: -1 }).lean();

  const counts: Record<string, number> = {};
  for (const k of kudos) counts[k.reaction] = (counts[k.reaction] || 0) + 1;

  const mine = kudos.find((k) => k.userId.toString() === actor._id.toString());

  res.json(
    new ApiResponse(
      200,
      {
        counts,
        myReaction: mine?.reaction || null,
        notes: kudos
          .filter((k) => k.note)
          .map((k) => ({
            authorName: k.authorName,
            authorAvatar: k.authorAvatar,
            note: k.note,
            reaction: k.reaction,
            createdAt: k.createdAt,
          })),
      },
      'Kudos fetched',
    ),
  );
});

export const putKudos = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { winnerId } = req.params;
  const { reaction, note } = req.body;

  if (!mongoose.Types.ObjectId.isValid(winnerId)) throw new ApiError(400, 'Invalid winner id');
  if (!EOTM_KUDOS_REACTIONS.includes(reaction)) throw new ApiError(400, 'Invalid reaction');

  const winner = await EmployeeOfMonth.findOne({ _id: winnerId, organizationId: actor.organizationId }).select('_id');
  if (!winner) throw new ApiError(404, 'Winner not found');

  const kudos = await EotmKudos.findOneAndUpdate(
    { winnerId, userId: actor._id },
    {
      organizationId: actor.organizationId,
      authorName: actor.fullName,
      authorAvatar: actor.avatar,
      reaction,
      note: typeof note === 'string' ? note.trim().slice(0, 280) : undefined,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.json(new ApiResponse(200, kudos, 'Kudos saved'));
});

export const deleteKudos = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { winnerId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(winnerId)) throw new ApiError(400, 'Invalid winner id');
  await EotmKudos.deleteOne({ winnerId, userId: actor._id });
  res.json(new ApiResponse(200, {}, 'Kudos removed'));
});

export default {
  listTeams,
  createTeam,
  updateTeam,
  getCurrent,
  getCandidates,
  setWinner,
  clearWinner,
  getHistory,
  deleteHistoryEntry,
  getStats,
  listNominations,
  createNomination,
  dismissNomination,
  getKudos,
  putKudos,
  deleteKudos,
};
