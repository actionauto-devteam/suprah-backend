import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Meeting from '../models/Meeting.model';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';

/** Select only unused native drafts with the exact default title. */
function cleanupScope(req: Request) {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to an organization.');
  return {
    organizationId: user.organizationId,
    ...(['admin', 'manager'].includes(user.role) ? {} : { hostCrmUserId: user._id }),
    title: /^\s*Instant meeting\s*$/i,
    status: 'scheduled', calendarSourceId: null,
    startedAt: null, endedAt: null, chimeMeetingId: null,
    participants: { $size: 0 },
    'recording.status': { $in: ['idle', null] },
    'recording.capturePipelineId': null, 'recording.videoKey': null,
    'ai.status': { $in: ['idle', null] },
    'ai.transcriptKey': null, 'ai.summary.overview': null,
    'distribution.sentAt': null,
  };
}

export const previewUnusedMeetings = asyncHandler(async (req: Request, res: Response) => {
  const meetings = await Meeting.find(cleanupScope(req)).sort({ scheduledAt: 1, createdAt: 1 })
    .limit(200).select('_id code title scheduledAt seriesId hostCrmUserId createdAt').lean();
  res.json(new ApiResponse(200, { meetings }, 'Unused Instant meeting schedules'));
});

export const removeUnusedMeetings = asyncHandler(async (req: Request, res: Response) => {
  const scope = cleanupScope(req);
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 ||
    !ids.every(id => typeof id === 'string' && mongoose.isObjectIdOrHexString(id))) {
    throw new ApiError(400, 'Select between 1 and 200 valid meeting schedules.');
  }
  // Recheck every safety condition at deletion time, restricted to the exact
  // IDs the operator reviewed. A newly live room or changed title is retained.
  const result = await Meeting.deleteMany({ ...scope, _id: { $in: [...new Set(ids)] } });
  res.json(new ApiResponse(200, { deletedCount: result.deletedCount }, 'Unused schedules removed'));
});
