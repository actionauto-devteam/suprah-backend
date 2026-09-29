import express from "express";
import auth from "../middleware/auth.middleware";
import dispatchChannelController from "../controllers/dispatchChannel.controller";
import { uploadDispatchChatFiles } from "../middleware/dispatchChatAttachment.middleware";

// Dispatch Chat channels. Signed-in drivers and staff only (checked in the
// controller); no organization is required because members can come from
// any organization and drivers are a shared pool.
const router = express.Router();

router.use(auth());
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});

router.get("/people", dispatchChannelController.searchPeople);

router
  .route("/")
  .get(dispatchChannelController.listChannels)
  .post(dispatchChannelController.createChannel);

router
  .route("/:id")
  .get(dispatchChannelController.getChannel)
  .patch(dispatchChannelController.updateChannel);

router.post("/:id/close", dispatchChannelController.closeChannel);
router.post("/:id/leave", dispatchChannelController.leaveChannel);

router.post("/:id/members", dispatchChannelController.addMembers);
router.delete("/:id/members/:userId", dispatchChannelController.removeMember);
router.patch("/:id/members/:userId/role", dispatchChannelController.changeMemberRole);

router.post("/:id/suggestions", dispatchChannelController.suggestMember);
router.post("/:id/suggestions/:suggestionId/approve", dispatchChannelController.approveSuggestion);
router.post("/:id/suggestions/:suggestionId/decline", dispatchChannelController.declineSuggestion);

router
  .route("/:id/messages")
  .get(dispatchChannelController.getMessages)
  .post(dispatchChannelController.sendMessage);
// Photos and files: same types and limits as private Dispatch Chat.
router.post("/:id/attachments", uploadDispatchChatFiles, dispatchChannelController.uploadAttachments);
router
  .route("/:id/messages/:messageId")
  .patch(dispatchChannelController.editMessage)
  .delete(dispatchChannelController.deleteMessage);
router.post("/:id/read", dispatchChannelController.markRead);

export default router;
