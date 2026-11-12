import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import {
    approveStaffDeletion,
    cancelMyStaffDeletionRequest,
    listStaffDeletionRequests,
    myStaffDeletionRequest,
    rejectStaffDeletion,
    requestStaffDeletion,
    type Reviewer,
} from '../services/staffDeletionRequest.service';

/*
 * /api/account-deletion-requests (2026-11-12): staff ask to delete their
 * account; an admin of their dealership approves or rejects it with a reason.
 * See services/staffDeletionRequest.service for the rules.
 */

function signedIn(req: Request) {
    const user = req.user as { _id?: unknown; role?: unknown; organizationId?: unknown; name?: unknown } | undefined;
    if (!user?._id) throw new ApiError(401, 'Your session ended. Sign in again to continue.');
    return user as { _id: unknown; role?: unknown; organizationId?: unknown; name?: unknown };
}

function reviewerFrom(req: Request): Reviewer {
    const user = signedIn(req);
    return { _id: user._id, role: user.role, name: user.name, orgId: req.orgId, orgRole: req.orgRole };
}

/** GET /mine — the staff member's open request, or their last declined one. */
const mine = asyncHandler(async (req: Request, res: Response) => {
    const user = signedIn(req);
    res.json(new ApiResponse(200, await myStaffDeletionRequest(user._id), 'Deletion request'));
});

/** POST / — body { acknowledgedRetention: true, note? } */
const create = asyncHandler(async (req: Request, res: Response) => {
    const user = signedIn(req);
    const request = await requestStaffDeletion(user, {
        acknowledgedRetention: req.body?.acknowledgedRetention,
        note: req.body?.note,
    });
    res.status(201).json(new ApiResponse(201, request, 'Your request was sent to your dealership admin.'));
});

/** DELETE /mine — cancels the open request. */
const cancel = asyncHandler(async (req: Request, res: Response) => {
    const user = signedIn(req);
    await cancelMyStaffDeletionRequest(user._id);
    res.json(new ApiResponse(200, null, 'Your request was cancelled.'));
});

/** GET / — the reviewer's dealership: open requests and the last 30 days' decisions. */
const list = asyncHandler(async (req: Request, res: Response) => {
    res.json(new ApiResponse(200, await listStaffDeletionRequests(reviewerFrom(req)), 'Deletion requests'));
});

/** POST /:id/approve */
const approve = asyncHandler(async (req: Request, res: Response) => {
    const { transferredLoadNumbers } = await approveStaffDeletion(reviewerFrom(req), req.params.id);
    res.json(
        new ApiResponse(
            200,
            { transferredLoadNumbers },
            transferredLoadNumbers.length
                ? `Account deleted. You are now the responsible dispatcher for ${transferredLoadNumbers.length === 1 ? 'load' : 'loads'} ${transferredLoadNumbers.join(', ')}.`
                : 'Account deleted.',
        ),
    );
});

/** POST /:id/reject — body { reason } (5 to 500 characters). */
const reject = asyncHandler(async (req: Request, res: Response) => {
    await rejectStaffDeletion(reviewerFrom(req), req.params.id, req.body?.reason);
    res.json(new ApiResponse(200, null, 'Request rejected. They can see your reason.'));
});

export default { mine, create, cancel, list, approve, reject };
