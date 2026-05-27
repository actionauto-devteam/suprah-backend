import express from "express";
import chatController from "../controllers/chat.controller";

// NOTE: No auth/org middleware here on purpose.
// This router is mounted under appointmentDashboard.routes via
//   router.use("/chat", chatRoutes)
// so it inherits crmAuth() + requireOrg from the parent router.
const router = express.Router();

router
  .route("/")
  .get(chatController.getMessages)
  .post(chatController.createMessage);

router
  .route("/:id")
  .patch(chatController.updateMessage)
  .delete(chatController.deleteMessage);

export default router;