import { Router } from "express";
import customerShopAi from "../controllers/customerShopAi.controller";


const router = Router();


router.get("/session", customerShopAi.getSession);
router.post("/chat", customerShopAi.chat);
router.post("/recommend", customerShopAi.recommend);
router.post("/reset", customerShopAi.reset);

export default router;