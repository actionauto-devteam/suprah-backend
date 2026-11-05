import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import quoteController from "../controllers/quote.controller";
import shipmentChatController from "../controllers/shipmentChat.controller";
import { uploadShipmentChatPhotos } from "../middleware/dispatchChatAttachment.middleware";
import { dispatchChatMessageLimiter, dispatchChatUploadLimiter } from "../middleware/transportRateLimit.middleware";
import auth from "../middleware/auth.middleware";
import authorize from "../middleware/role.middleware";
import { ApiError } from "../utils/ApiError";
import { SUPPORT_EMAIL } from "../utils/userMessages";

// Customers asking for shipping on a marketplace vehicle from the customer
// portal. No organization is needed: the request goes to the dealership that
// owns the vehicle. Staff keep creating quotes through /api/quotes.
const router = express.Router();

// Each request reaches a dealership's staff, so cap how many one customer sends.
const customerQuoteRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skip: () => process.env.SKIP_RATE_LIMIT === "true",
  keyGenerator: (req: any) => req.user?._id?.toString() ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: `You've asked for a lot of shipping quotes in the last hour. Wait a while, then try again. If this keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
  },
  handler: (req, res, next, options) => {
    next(new ApiError(429, options.message.message));
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// The live map refreshes about once a minute per open shipment; this leaves
// room for several shipments on a few devices, and stops runaway refreshing.
const customerTrackingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 150,
  skip: () => process.env.SKIP_RATE_LIMIT === "true",
  keyGenerator: (req: any) => req.user?._id?.toString() ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: "The live map is refreshing too often. It will update again in a few minutes; you can keep using My Shipments meanwhile.",
  },
  handler: (req, res, next, options) => {
    next(new ApiError(429, options.message.message));
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(auth());
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});

router.post(
  "/",
  authorize("customer", "Shipping requests here are for customer accounts. Staff create quotes from the Transportation page."),
  customerQuoteRequestLimiter,
  quoteController.createCustomerQuoteRequest,
);

// The customer's own requests and how each shipment is going ("My Shipments").
router.get(
  "/mine",
  authorize("customer", "My Shipments is for customer accounts. Staff see quotes and loads on the Transportation page."),
  quoteController.getMyShipments,
);

// Where the driver carrying the customer's car is, from pickup until delivery.
router.get(
  "/:id/tracking",
  authorize("customer", "The live map is for the customer receiving the vehicle. Staff see the driver on Driver Tracker."),
  customerTrackingLimiter,
  quoteController.getShipmentTracking,
);

// The customer's private chats about a shipment: "driver" (the driver carrying
// the car) or "dispatcher" (the load's dispatcher). Text and photos.
const chatCustomerOnly = authorize("customer", "This chat is for the customer receiving the vehicle. Staff and drivers open it from the load.");
router.get("/:id/chats/:kind", chatCustomerOnly, shipmentChatController.getCustomerChat);
router.post("/:id/chats/:kind/messages", chatCustomerOnly, dispatchChatMessageLimiter, shipmentChatController.sendCustomerMessage);
router.post(
  "/:id/chats/:kind/photos",
  chatCustomerOnly,
  dispatchChatUploadLimiter,
  uploadShipmentChatPhotos,
  shipmentChatController.sendCustomerPhotos,
);
router.post("/:id/chats/:kind/read", chatCustomerOnly, shipmentChatController.markCustomerChatRead);

// The customer withdraws their own request while it is still waiting.
router.post(
  "/:id/withdraw",
  authorize("customer", "Only the customer who sent a shipping request can withdraw it."),
  quoteController.withdrawCustomerQuoteRequest,
);

export default router;
