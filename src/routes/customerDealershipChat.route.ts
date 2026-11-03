import express from "express";
import type { Request, Response } from "express";
import auth from "../middleware/auth.middleware";
import authorize from "../middleware/role.middleware";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { dealershipChatFor } from "../services/customerDealershipChat.service";

const router = express.Router();

router.use(auth());

// GET /api/customer/dealership-chat
// The signed-in customer's own dealership chat (its AI Agent), for the chat
// button on every customer portal page. Only their own dealership's.
router.get(
  "/",
  authorize("customer", "This chat is for customer accounts. Staff talk to customers from the CRM."),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as { organizationId?: unknown } | undefined;
    const chat = await dealershipChatFor(user?.organizationId);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json(new ApiResponse(200, chat, chat.available ? "Dealership chat" : "No dealership chat"));
  }),
);

export default router;
