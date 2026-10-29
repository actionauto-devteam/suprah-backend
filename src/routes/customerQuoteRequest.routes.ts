import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import quoteController from "../controllers/quote.controller";
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

export default router;
