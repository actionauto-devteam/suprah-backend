import express from "express";
import crmAuth from "../middleware/crmAuth.middleware";
import contactController from "../controllers/contact.controller";

/**
 * Suprah One Desk — Contacts (org-shared phonebook), mounted at
 * /api/crm/contacts. Powers the SMS and Call panes' saved-contacts lists.
 */

const router = express.Router();

router.use(crmAuth());

router.get("/", contactController.listContacts);
router.post("/", contactController.createContact);
router.delete("/:id", contactController.deleteContact);

export default router;
