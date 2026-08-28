import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import EmployeeOfMonth, { EmployeeOfMonthTeam } from '../models/EmployeeOfMonth.model';
import CrmUser from '../models/CrmUser.model';

const TEAMS: EmployeeOfMonthTeam[] = ['Philippines', 'Utah'];

function requireActor(req: Request) {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization');
  }
  return actor;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function isTeam(value: unknown): value is EmployeeOfMonthTeam {
  return TEAMS.includes(value as EmployeeOfMonthTeam);
}

export const getCurrent = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const month = currentMonth();

  const rows = await EmployeeOfMonth.find({ organizationId: actor.organizationId, month })
    .populate('employeeId', 'fullName username avatar role department')
    .lean();

  const byTeam: Record<EmployeeOfMonthTeam, unknown> = { Philippines: null, Utah: null };
  for (const row of rows) {
    byTeam[row.team] = {
      employee: row.employeeId,
      note: row.note || null,
      setAt: row.updatedAt,
    };
  }

  res.json(new ApiResponse(200, { month, philippines: byTeam.Philippines, utah: byTeam.Utah }, 'Employee of the month fetched'));
});

export const getCandidates = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { team, q } = req.query;

  if (!isTeam(team)) {
    throw new ApiError(400, 'A valid team (Philippines or Utah) is required');
  }

  const filter: Record<string, unknown> = {
    organizationId: actor.organizationId,
    isActive: true,
    payrollLocation: team,
  };

  const query = typeof q === 'string' ? q.trim() : '';
  if (query) {
    filter.fullName = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const users = await CrmUser.find(filter)
    .select('fullName username avatar role department')
    .sort({ fullName: 1 })
    .limit(20)
    .lean();

  res.json(new ApiResponse(200, { users }, 'Candidates fetched'));
});

export const setWinner = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can set the Employee of the Month');
  }

  const { team, employeeId, note } = req.body;

  if (!isTeam(team)) {
    throw new ApiError(400, 'A valid team (Philippines or Utah) is required');
  }
  if (!employeeId || typeof employeeId !== 'string') {
    throw new ApiError(400, 'employeeId is required');
  }

  const employee = await CrmUser.findOne({
    _id: employeeId,
    organizationId: actor.organizationId,
    payrollLocation: team,
  }).select('fullName username avatar role department');

  if (!employee) {
    throw new ApiError(404, 'Employee not found on that team');
  }

  const month = currentMonth();

  const row = await EmployeeOfMonth.findOneAndUpdate(
    { organizationId: actor.organizationId, team, month },
    {
      employeeId: employee._id,
      note: typeof note === 'string' ? note.trim().slice(0, 280) : undefined,
      setByUserId: actor._id,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  res.json(
    new ApiResponse(
      200,
      { month, team, employee, note: row?.note || null, setAt: row?.updatedAt },
      'Employee of the month updated',
    ),
  );
});

export default { getCurrent, getCandidates, setWinner };
