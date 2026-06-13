import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import AftermarketInquiry from "../models/AftermarketInquiry.model";
import AftermarketProduct from "../models/AftermarketProduct.model";
import Organization from "../models/Organization.model";
import CrmUser from "../models/CrmUser.model";
import SupraSpaceConversation from "../models/SupraSpaceConversation.model";
import SupraSpaceMessage from "../models/SupraSpaceMessage.model";
import { getIO } from "../socket/supraspace.socket";
import logger from "../utils/logger";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveCustomerOrg(req: Request): Promise<string | undefined> {
  if (req.orgId) return req.orgId;
  const orgCount = await Organization.countDocuments({});
  if (orgCount === 1) {
    const only = await Organization.findOne().select("_id");
    if (only) return only._id.toString();
  }
  return undefined;
}

async function getCrmStaffIds(): Promise<mongoose.Types.ObjectId[]> {
  const staff = await CrmUser.find({
    isActive: true,
    role: { $in: ["admin", "agent", "sales_rep", "manager", "super_admin"] },
  })
    .select("_id")
    .lean();
  return staff.map((u: any) => u._id);
}

function customerSentinelId(customerId: string): mongoose.Types.ObjectId {
  const hex = Buffer.from(customerId.padEnd(12, "\0").slice(0, 12)).toString(
    "hex",
  );
  return new mongoose.Types.ObjectId(hex);
}

function emitToConversation(conv: any, event: string, payload: any) {
  try {
    const io = getIO();
    (conv.members || []).forEach((m: any) => {
      io.to(`user:${m.toString ? m.toString() : m}`).emit(event, payload);
    });
    if (conv._id) io.to(`conv:${conv._id.toString()}`).emit(event, payload);
  } catch (err) {
    logger.warn({ err }, "[AftermarketInquiry] Socket emit failed");
  }
}

/**
 * Build the rich message body that will appear in Suprah Space.
 * Includes product context so CRM staff immediately know what product
 * the customer is asking about — no back-and-forth needed.
 */
function buildInquiryMessageContent(
  product: { name: string; _id: any; price?: number },
  question: string,
  customerName: string,
): string {
  return [
    `Product inquiry from ${customerName}`,
    `Product: ${product.name}`,
    `Question:`,
    question.trim(),
  ].join("\n");
}

// ─── Customer: submit an inquiry ─────────────────────────────────────────────

/**
 * POST /api/aftermarket/:productId/inquiries
 * Body: { question }
 *
 * Creates an AftermarketInquiry record and routes the question into the
 * customer's Suprah Space concern conversation, pre-filled with the full
 * product context so CRM staff can respond immediately.
 */
export const submitInquiry = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user?._id) throw new ApiError(401, "Not authenticated");

    const orgId = await resolveCustomerOrg(req);
    if (!orgId) throw new ApiError(403, "No organization context.");

    const { productId } = req.params;
    const { question } = req.body;

    if (!question?.trim() || question.trim().length < 5) {
      throw new ApiError(400, "Please enter a question (minimum 5 characters)");
    }
    if (question.trim().length > 2000) {
      throw new ApiError(400, "Question must be 2000 characters or less");
    }

    const product = await AftermarketProduct.findOne({
      _id: productId,
      organizationId: orgId,
      isActive: true,
    });
    if (!product) throw new ApiError(404, "Product not found");

    const customerId = user._id.toString();
    const customerName =
      user.fullName ||
      user.name ||
      `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
      "Customer";
    const customerEmail =
      user.email || user.primaryEmailAddress?.emailAddress || "";

    // ── Get or create the concern conversation for this customer ──────────────
    let conversation = await SupraSpaceConversation.findOne({
      "metadata.type": "customer_concern",
      "metadata.customerUserId": customerId,
      isActive: true,
    });

    if (!conversation) {
      const staffIds = await getCrmStaffIds();
      conversation = await SupraSpaceConversation.create({
        type: "group",
        name: `${customerName} — Support`,
        members: staffIds,
        admins: [],
        createdBy: staffIds[0] || new mongoose.Types.ObjectId(),
        metadata: {
          type: "customer_concern",
          customerUserId: customerId,
          customerName,
          customerEmail,
        },
      });
      emitToConversation(conversation, "concern:new", conversation.toObject());
    }

    // ── Post the product-context message into the conversation ─────────────────
    const messageContent = buildInquiryMessageContent(
      product,
      question,
      customerName,
    );
    const sentinelId = customerSentinelId(customerId);

    const message = await SupraSpaceMessage.create({
      conversationId: conversation._id,
      sender: sentinelId,
      content: messageContent,
      type: "text",
      attachments: [],
      readBy: [],
      metadata: {
        isCustomerMessage: true,
        customerUserId: customerId,
        customerName,
        customerEmail,
        customerAvatar: user.imageUrl || user.avatar || "",
        // Tag so the CRM tab can show a "Product Inquiry" badge
        inquiryProductId: productId,
        inquiryProductName: product.name,
      },
    });

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const msgObj = message.toObject() as any;
    msgObj.sender = {
      _id: customerId,
      fullName: customerName,
      avatar: user.imageUrl || "",
      isCustomer: true,
    };

    emitToConversation(conversation, "message:new", {
      conversationId: conversation._id.toString(),
      message: msgObj,
    });

    // Notify the CRM staff room
    try {
      getIO()
        .to("crm:staff")
        .emit("concern:message", {
          conversationId: conversation._id.toString(),
          customerName,
          preview: `📦 Product inquiry: ${product.name}`,
        });
    } catch {}

    // ── Persist the inquiry record ─────────────────────────────────────────────
    const inquiry = await AftermarketInquiry.create({
      productId,
      organizationId: orgId,
      customerId: user._id,
      productName: product.name,
      productPrice: product.price,
      customerName,
      customerEmail,
      question: question.trim(),
      conversationId: conversation._id,
      messageId: message._id,
      status: "open",
    });

    res
      .status(201)
      .json(
        new ApiResponse(
          201,
          { inquiry, conversationId: conversation._id },
          "Inquiry submitted successfully",
        ),
      );
  },
);

// ─── Customer: my inquiries ───────────────────────────────────────────────────

/**
 * GET /api/aftermarket/inquiries/mine
 */
export const getMyInquiries = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user?._id) throw new ApiError(401, "Not authenticated");

    const inquiries = await AftermarketInquiry.find({ customerId: user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json(new ApiResponse(200, inquiries, "Inquiries fetched"));
  },
);

// ─── Admin (CRM): list all inquiries ──────────────────────────────────────────

/**
 * GET /api/crm/aftermarket/inquiries
 * Query: ?status=open|answered|closed&productId=&page=&limit=
 */
export const adminListInquiries = asyncHandler(
  async (req: Request, res: Response) => {
    const actor = req.crmUser;
    if (!actor) throw new ApiError(401, "Not authenticated");
    if (!actor.organizationId)
      throw new ApiError(403, "No organization context.");

    const { status, productId, page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, any> = {
      organizationId: actor.organizationId,
    };
    if (status) filter.status = status;
    if (productId) filter.productId = productId;

    const [inquiries, total] = await Promise.all([
      AftermarketInquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AftermarketInquiry.countDocuments(filter),
    ]);

    res.json(
      new ApiResponse(
        200,
        {
          inquiries,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
          },
        },
        "Inquiries fetched",
      ),
    );
  },
);

/**
 * PATCH /api/crm/aftermarket/inquiries/:inquiryId  { status }
 */
export const adminUpdateInquiryStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const actor = req.crmUser;
    if (!actor) throw new ApiError(401, "Not authenticated");

    const { inquiryId } = req.params;
    const { status } = req.body;

    if (!["open", "answered", "closed"].includes(status)) {
      throw new ApiError(400, "status must be open | answered | closed");
    }

    const inquiry = await AftermarketInquiry.findOneAndUpdate(
      { _id: inquiryId, organizationId: actor.organizationId },
      { status },
      { new: true },
    );
    if (!inquiry) throw new ApiError(404, "Inquiry not found");

    res.json(new ApiResponse(200, inquiry, "Inquiry status updated"));
  },
);
