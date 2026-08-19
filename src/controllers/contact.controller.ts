import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Contact from "../models/Contact.model";
import { normalizePhone } from "../services/communication.service";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GET /api/crm/contacts?q= */
export const listContacts = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const q = String(req.query.q || "").trim();

  const query: any = { organizationId: orgId };
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    query.$or = [{ name: regex }, { phoneNumber: regex }];
  }

  const contacts = await Contact.find(query).sort({ name: 1 }).limit(500).lean();
  res.json(new ApiResponse(200, { contacts }, "Contacts fetched"));
});

/** POST /api/crm/contacts  body: { name, phoneNumber } */
export const createContact = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const crmUser = req.crmUser!;
  const { name, phoneNumber } = req.body || {};

  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new ApiError(400, "Name is required");
  if (!String(phoneNumber || "").trim()) throw new ApiError(400, "Phone number is required");

  const normalized = normalizePhone(String(phoneNumber));

  try {
    const contact = await Contact.create({
      organizationId: orgId,
      name: trimmedName,
      phoneNumber: normalized,
      createdBy: { userId: crmUser._id, name: crmUser.fullName },
    });
    res.status(201).json(new ApiResponse(201, { contact }, "Contact saved"));
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await Contact.findOne({ organizationId: orgId, phoneNumber: normalized }).lean();
      throw new ApiError(
        409,
        existing ? `This number is already saved as "${existing.name}"` : "This number is already saved",
      );
    }
    throw error;
  }
});

/** DELETE /api/crm/contacts/:id */
export const deleteContact = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const deleted = await Contact.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!deleted) throw new ApiError(404, "Contact not found");

  res.json(new ApiResponse(200, null, "Contact deleted"));
});

export default { listContacts, createContact, deleteContact };
