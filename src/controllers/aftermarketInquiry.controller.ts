import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import AftermarketInquiry from "../models/AftermarketInquiry.model";
import AftermarketProduct from "../models/AftermarketProduct.model";
import Organization from "../models/Organization.model";
import CrmUser from "../models/CrmUser.model";
import User from "../models/User.model";
import Payment, { IPaymentLineItem } from "../models/Payment.model";
import SupraSpaceConversation from "../models/SupraSpaceConversation.model";
import SupraSpaceMessage from "../models/SupraSpaceMessage.model";
import { getIO } from "../socket/supraspace.socket";
import { emitToUser } from "../utils/socketEmitter";
import notificationService from "../services/notification.service";
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

async function getCrmStaffIds(orgId?: string): Promise<mongoose.Types.ObjectId[]> {
  const filter: any = {
    isActive: true,
    role: { $in: ["admin", "agent", "sales_rep", "manager", "super_admin"] },
  };
  if (orgId) filter.organizationId = orgId;
  const staff = await CrmUser.find(filter).select("_id").lean();
  return staff.map((u: any) => u._id);
}

function customerSentinelId(customerId: string): mongoose.Types.ObjectId {
  const hex = Buffer.from(customerId.padEnd(12, "\0").slice(0, 12)).toString("hex");
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

/** Fire a CRM notification + real-time event for a brand-new inquiry. */
async function notifyCrmOfInquiry(params: {
  orgId: string;
  inquiry: any;
  product: any;
}) {
  const { orgId, inquiry, product } = params;

  // Real-time ping to the support console (SupraSpace socket / crm:staff room)
  try {
    getIO().to("crm:staff").emit("aftermarket:inquiry_new", {
      inquiryId: inquiry._id.toString(),
      productId: product._id.toString(),
      productName: product.name,
      customerName: inquiry.customerName,
      customerEmail: inquiry.customerEmail,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
    });
  } catch { /* socket optional */ }

  // Persistent notifications for each staff member (drives bell + unread counters)
  try {
    const staffIds = await getCrmStaffIds(orgId);
    await Promise.allSettled(
      staffIds.map((sid) =>
        notificationService.createNotification({
          userId: sid.toString(),
          organizationId: orgId,
          type: "aftermarket_inquiry",
          title: "New aftermarket inquiry",
          message: `${inquiry.customerName} asked about "${product.name}".`,
          metadata: {
            route: "/crm/support-center?tab=aftermarket",
            inquiryId: inquiry._id.toString(),
            productId: product._id.toString(),
            productName: product.name,
            customerName: inquiry.customerName,
            customerEmail: inquiry.customerEmail,
            status: inquiry.status,
          },
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err }, "[AftermarketInquiry] CRM notification failed");
  }
}

// ─── Customer: submit an inquiry ─────────────────────────────────────────────

export const submitInquiry = asyncHandler(async (req: Request, res: Response) => {
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
  const customerEmail = user.email || user.primaryEmailAddress?.emailAddress || "";

  // ── Get or create the concern conversation for this customer ──────────────
  let conversation = await SupraSpaceConversation.findOne({
    "metadata.type": "customer_concern",
    "metadata.customerUserId": customerId,
    isActive: true,
  });

  if (!conversation) {
    const staffIds = await getCrmStaffIds(orgId);
    conversation = await SupraSpaceConversation.create({
      type: "group",
      name: `${customerName} — Support`,
      members: staffIds,
      admins: [],
      createdBy: staffIds[0] || new mongoose.Types.ObjectId(),
      metadata: {
        type: "customer_concern",
        source: "aftermarket",
        customerUserId: customerId,
        customerName,
        customerEmail,
      },
    });
  }

  const messageContent = buildInquiryMessageContent(product, question, customerName);
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

  // ── Notify CRM (bell notifications + live event + unread counters) ─────────
  await notifyCrmOfInquiry({ orgId, inquiry, product });

  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { inquiry, conversationId: conversation._id },
        "Inquiry submitted successfully",
      ),
    );
});

// ─── Customer: my inquiries ───────────────────────────────────────────────────

export const getMyInquiries = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as any;
  if (!user?._id) throw new ApiError(401, "Not authenticated");

  const inquiries = await AftermarketInquiry.find({ customerId: user._id })
    .sort({ createdAt: -1 })
    .lean();

  res.json(new ApiResponse(200, inquiries, "Inquiries fetched"));
});

// ─── Admin (CRM): list all inquiries ──────────────────────────────────────────

export const adminListInquiries = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, "Not authenticated");
  if (!actor.organizationId) throw new ApiError(403, "No organization context.");

  const { status, productId, search, page = "1", limit = "20" } = req.query;
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const filter: Record<string, any> = { organizationId: actor.organizationId };
  if (status && status !== "all") filter.status = status;
  if (productId) filter.productId = productId;
  if (search) {
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [
      { customerName: rx },
      { customerEmail: rx },
      { productName: rx },
      { question: rx },
    ];
  }

  const [inquiries, total, openCount] = await Promise.all([
    AftermarketInquiry.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    AftermarketInquiry.countDocuments(filter),
    AftermarketInquiry.countDocuments({ organizationId: actor.organizationId, status: "open" }),
  ]);

  // Attach whether each inquiry already has an invoice, for quick badges.
  const inquiryIds = inquiries.map((i: any) => i._id);
  const invoices = await Payment.find({ inquiryId: { $in: inquiryIds } })
    .select("inquiryId status amount invoiceNumber")
    .lean();
  const invoiceByInquiry = new Map<string, any>();
  invoices.forEach((p: any) => invoiceByInquiry.set(p.inquiryId.toString(), p));

  const enriched = inquiries.map((i: any) => ({
    ...i,
    invoice: invoiceByInquiry.get(i._id.toString()) || null,
  }));

  res.json(
    new ApiResponse(
      200,
      {
        inquiries: enriched,
        openCount,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
      },
      "Inquiries fetched",
    ),
  );
});

// ─── Admin (CRM): unread / open inquiry count (for tab badge) ─────────────────

export const adminInquiriesUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor?.organizationId) throw new ApiError(403, "No organization context.");
  const openCount = await AftermarketInquiry.countDocuments({
    organizationId: actor.organizationId,
    status: "open",
  });
  res.json(new ApiResponse(200, { openCount }, "Open inquiry count"));
});

// ─── Admin (CRM): full inquiry detail ─────────────────────────────────────────
// Returns the inquiry, the product (incl. photo/media), customer profile,
// this customer's full inquiry history, the linked support conversation, and
// any invoice already raised for it.

export const adminGetInquiryDetail = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor?.organizationId) throw new ApiError(403, "No organization context.");

  const { inquiryId } = req.params;
  const inquiry = await AftermarketInquiry.findOne({
    _id: inquiryId,
    organizationId: actor.organizationId,
  }).lean();
  if (!inquiry) throw new ApiError(404, "Inquiry not found");

  const [product, customer, history, invoice] = await Promise.all([
    AftermarketProduct.findById(inquiry.productId)
      .select("name price description media file isActive createdAt")
      .lean(),
    User.findById(inquiry.customerId)
      .select("name fullName firstName lastName email phone imageUrl avatar createdAt")
      .lean(),
    AftermarketInquiry.find({
      customerId: inquiry.customerId,
      organizationId: actor.organizationId,
      _id: { $ne: inquiry._id },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("productName question status createdAt productPrice")
      .lean(),
    Payment.findOne({ inquiryId: inquiry._id })
      .select("invoiceNumber status amount subtotal taxAmount lineItems createdAt paidAt dueDate")
      .lean(),
  ]);

  res.json(
    new ApiResponse(
      200,
      { inquiry, product, customer, history, invoice },
      "Inquiry detail fetched",
    ),
  );
});

// ─── Admin (CRM): create an invoice from an inquiry ───────────────────────────
//
// POST /api/crm/aftermarket/inquiries/:inquiryId/invoice
// Body: { lineItems: [{ label, kind, quantity, unitPrice }], taxRate?, dueDate?, notes? }
//
// Creates a Payment (source: 'aftermarket') against the inquiring customer's
// email so it surfaces on the customer Payments page, links it back to the
// product + inquiry, flips the inquiry to "answered", and notifies the customer.

export const adminCreateInvoiceForInquiry = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, "Not authenticated");
  if (!actor.organizationId) throw new ApiError(403, "No organization context.");

  const { inquiryId } = req.params;
  const { lineItems, taxRate = 0, dueDate, notes, description } = req.body as {
    lineItems?: Array<Partial<IPaymentLineItem>>;
    taxRate?: number;
    dueDate?: string;
    notes?: string;
    description?: string;
  };

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new ApiError(400, "At least one line item is required");
  }

  const inquiry = await AftermarketInquiry.findOne({
    _id: inquiryId,
    organizationId: actor.organizationId,
  });
  if (!inquiry) throw new ApiError(404, "Inquiry not found");

  // Guard against duplicate invoices for the same inquiry.
  const existing = await Payment.findOne({
    inquiryId: inquiry._id,
    status: { $nin: ["cancelled", "failed"] },
  });
  if (existing) {
    throw new ApiError(409, `An invoice (${existing.invoiceNumber || existing._id}) already exists for this inquiry.`);
  }

  // Normalise line items + compute totals.
  const normalized: IPaymentLineItem[] = lineItems.map((li) => {
    const quantity = Math.max(0, Number(li.quantity) || 0);
    const unitPrice = Number(li.unitPrice) || 0;
    const raw = quantity * unitPrice;
    const kind = (li.kind || "product") as IPaymentLineItem["kind"];
    const lineTotal = kind === "discount" ? -Math.abs(raw) : raw;
    return {
      label: String(li.label || "").trim() || "Item",
      kind,
      quantity,
      unitPrice,
      lineTotal: Math.round(lineTotal * 100) / 100,
    };
  });

  const subtotal = Math.round(normalized.reduce((s, li) => s + li.lineTotal, 0) * 100) / 100;
  const taxAmount = Math.round(Math.max(0, subtotal) * (Number(taxRate) || 0)) / 100;
  const amount = Math.round((subtotal + taxAmount) * 100) / 100;
  if (amount <= 0) throw new ApiError(400, "Invoice total must be greater than zero");

  const payment = await Payment.create({
    organizationId: actor.organizationId.toString(),
    orgId: actor.organizationId,
    customerId: inquiry.customerEmail.toLowerCase(),
    customerName: inquiry.customerName,
    customerEmail: inquiry.customerEmail.toLowerCase(),
    amount,
    subtotal,
    taxRate: Number(taxRate) || 0,
    taxAmount,
    lineItems: normalized,
    currency: "usd",
    description: description?.trim() || `Aftermarket: ${inquiry.productName}`,
    status: "pending",
    source: "aftermarket",
    aftermarketProductId: inquiry.productId,
    inquiryId: inquiry._id,
    dueDate: dueDate ? new Date(dueDate) : undefined,
    notes,
    createdBy: actor._id,
  });

  // Flip inquiry to "answered" — pricing has been provided.
  inquiry.status = "answered";
  await inquiry.save();

  // Notify the customer (bell + push + real-time) so it appears on their Payments page.
  try {
    await notificationService.createNotification({
      userId: inquiry.customerId.toString(),
      organizationId: actor.organizationId.toString(),
      type: "aftermarket_invoice",
      title: "Your invoice is ready",
      message: `An invoice of $${amount.toFixed(2)} for "${inquiry.productName}" is ready to pay.`,
      metadata: {
        route: "/customer/payments",
        paymentId: payment._id.toString(),
        invoiceNumber: payment.invoiceNumber,
        amount,
        productName: inquiry.productName,
      },
    });
  } catch (err) {
    logger.warn({ err }, "[AftermarketInquiry] customer invoice notification failed");
  }

  // Real-time nudge to the customer's open app, and CRM support room.
  try {
    emitToUser(inquiry.customerId.toString(), "payment:new", {
      paymentId: payment._id.toString(),
      amount,
      invoiceNumber: payment.invoiceNumber,
    });
  } catch { /* noop */ }
  try {
    getIO().to("crm:staff").emit("aftermarket:inquiry_invoiced", {
      inquiryId: inquiry._id.toString(),
      paymentId: payment._id.toString(),
    });
  } catch { /* noop */ }

  res.status(201).json(new ApiResponse(201, { payment, inquiry }, "Invoice created and sent to customer"));
});

// ─── Admin (CRM): update inquiry status ───────────────────────────────────────

export const adminUpdateInquiryStatus = asyncHandler(async (req: Request, res: Response) => {
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

  try {
    getIO().to("crm:staff").emit("aftermarket:inquiry_updated", {
      inquiryId: inquiry._id.toString(),
      status,
    });
  } catch { /* noop */ }

  res.json(new ApiResponse(200, inquiry, "Inquiry status updated"));
});