import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import CrmUser from "../models/CrmUser.model";

function daysUntilNextOccurrence(month: number, day: number): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisYear = now.getFullYear();
  let next = new Date(thisYear, month, day);
  if (next < today) next = new Date(thisYear + 1, month, day);
  return Math.round((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Get upcoming milestones (birthdays + work anniversaries)
 * GET /api/crm/hr/milestones?window=30
 */
const getMilestones = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor) throw new ApiError(401, "Not authenticated");

  if (!actor.organizationId) {
    throw new ApiError(403, "Your account is not linked to any organization.");
  }

  const window = Math.min(Math.max(parseInt(req.query.window as string) || 30, 1), 90);

  const users = await CrmUser.find({
    organizationId: actor.organizationId,
    isActive: true,
    $or: [{ birthday: { $ne: null } }, { hireDate: { $ne: null } }],
  }).select("fullName username avatar role birthday hireDate");

  type MilestoneEntry = {
    _id: string;
    fullName: string;
    username: string;
    avatar?: string | null;
    role: string;
    daysUntil: number;
    date: Date;
    type: "birthday" | "anniversary";
    yearsCount?: number;
  };

  const birthdays: MilestoneEntry[] = [];
  const anniversaries: MilestoneEntry[] = [];

  const currentYear = new Date().getFullYear();

  for (const u of users) {
    if (u.birthday) {
      const d = daysUntilNextOccurrence(u.birthday.getMonth(), u.birthday.getDate());
      if (d <= window) {
        birthdays.push({
          _id: u._id.toString(),
          fullName: u.fullName,
          username: u.username,
          avatar: u.avatar,
          role: u.role,
          daysUntil: d,
          date: u.birthday,
          type: "birthday",
        });
      }
    }

    if (u.hireDate) {
      const yearsCount = currentYear - u.hireDate.getFullYear();
      if (yearsCount > 0) {
        const d = daysUntilNextOccurrence(u.hireDate.getMonth(), u.hireDate.getDate());
        if (d <= window) {
          anniversaries.push({
            _id: u._id.toString(),
            fullName: u.fullName,
            username: u.username,
            avatar: u.avatar,
            role: u.role,
            daysUntil: d,
            date: u.hireDate,
            type: "anniversary",
            yearsCount,
          });
        }
      }
    }
  }

  birthdays.sort((a, b) => a.daysUntil - b.daysUntil);
  anniversaries.sort((a, b) => a.daysUntil - b.daysUntil);

  res.json(
    new ApiResponse(200, { birthdays, anniversaries }, "Milestones fetched successfully"),
  );
});

/**
 * Get offboarded employees
 * GET /api/crm/hr/offboarded
 */
const getOffboarded = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;

  if (!actor) throw new ApiError(401, "Not authenticated");

  if (!actor.organizationId) {
    throw new ApiError(403, "Your account is not linked to any organization.");
  }

  const users = await CrmUser.find({
    organizationId: actor.organizationId,
    isOffboarded: true,
  })
    .select("fullName username email avatar role hireDate offboardedAt createdAt")
    .sort({ offboardedAt: -1 });

  res.json(new ApiResponse(200, { users }, "Offboarded users fetched successfully"));
});

export default { getMilestones, getOffboarded };
