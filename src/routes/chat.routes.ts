import express from "express";
import chatController from "../controllers/chat.controller";

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