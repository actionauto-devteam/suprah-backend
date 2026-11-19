import { Request, Response } from 'express';
import { ApiResponse } from '../utils/ApiResponse';
import { completeLeadMentions, countNewLeadMentions, listLeadMentions } from '../services/leadMention.service';

const viewer = (req: Request) => (req as any).crmUser || (req as any).user;

function fail(res: Response, error: any, message: string) {
  const statusCode = Number(error?.statusCode) || 500;
  if (statusCode >= 500) console.error(`[ERROR] ${message}:`, error);
  res.status(statusCode).json({ message: statusCode >= 500 ? message : error.message });
}

export const listLeadMentionsHandler = async (req: Request, res: Response) => {
  if (!req.orgId) return res.status(400).json({ message: 'Organization context missing' });
  try {
    const result = await listLeadMentions(String(req.orgId), viewer(req), {
      status: req.query.status,
      q: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(new ApiResponse(200, result));
  } catch (error) {
    fail(res, error, 'Could not load your mentions');
  }
};

export const getLeadMentionCountHandler = async (req: Request, res: Response) => {
  if (!req.orgId) return res.status(400).json({ message: 'Organization context missing' });
  try {
    const count = await countNewLeadMentions(String(req.orgId), viewer(req));
    res.json(new ApiResponse(200, { count }));
  } catch (error) {
    fail(res, error, 'Could not count your mentions');
  }
};

export const completeLeadMentionsHandler = async (req: Request, res: Response) => {
  if (!req.orgId) return res.status(400).json({ message: 'Organization context missing' });
  try {
    const completed = await completeLeadMentions(String(req.orgId), viewer(req), {
      all: req.body?.all,
      mentionId: req.body?.mentionId,
      noteId: req.body?.noteId,
      before: req.body?.before,
    });
    res.json(new ApiResponse(200, { completed }));
  } catch (error) {
    fail(res, error, 'Could not update your mentions');
  }
};
