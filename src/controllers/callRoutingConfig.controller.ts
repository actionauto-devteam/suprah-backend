import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import CallRoutingConfig from '../models/CallRoutingConfig.model';
import { parseRoutingConfig, validateRoutingGroups } from '../services/callRoutingConfig.service';
import { COMPANY_NUMBER } from '../services/telnyx.service';

function admin(req: Request) {
  if (req.crmUser?.role !== 'admin') throw new ApiError(403, 'Only admins can manage call routing');
  return { orgId: String(req.orgId), userId: req.crmUser._id };
}

export const listRoutingConfigs = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = admin(req);
  const configs = await CallRoutingConfig.find({ organizationId: orgId }).sort({ name: 1 }).lean();
  res.json(new ApiResponse(200, { configs, configuredIngressNumber: COMPANY_NUMBER, externalTransferSupported: false }, 'Call routing configurations'));
});

export const saveRoutingConfig = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, userId } = admin(req);
  const config = parseRoutingConfig(req.body, COMPANY_NUMBER);
  await validateRoutingGroups(orgId, config);
  const id = req.params.id;
  if (id && !mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid configuration ID');
  const externalNumbers = config.options.map(option => option.externalDestination).filter(Boolean);
  if (externalNumbers.length && await CallRoutingConfig.exists({ inboundNumber: { $in: externalNumbers } })) {
    throw new ApiError(400, 'External destination cannot be another configured IVR ingress');
  }
  const other = await CallRoutingConfig.exists({ inboundNumber: config.inboundNumber, ...(id ? { _id: { $ne: id } } : {}) });
  if (other) throw new ApiError(409, 'This inbound number already has a routing configuration');
  try {
    const row = id
      ? await CallRoutingConfig.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: { ...config, updatedBy: userId } }, { new: true, runValidators: true })
      : await CallRoutingConfig.create({ ...config, organizationId: orgId, updatedBy: userId });
    if (!row) throw new ApiError(404, 'Routing configuration not found');
    res.json(new ApiResponse(200, row, 'Call routing saved'));
  } catch (error: any) {
    if (error?.code === 11000) throw new ApiError(409, 'This inbound number already has a routing configuration');
    throw error;
  }
});
