import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import dealBoardController from '../controllers/dealBoard.controller';

const router = Router();
router.use(auth());

router.get('/',              dealBoardController.getDeals);
router.post('/',             dealBoardController.createDeal);
router.patch('/reorder',     dealBoardController.reorderDeals);
router.patch('/:id',         dealBoardController.updateDeal);
router.patch('/:id/move',    dealBoardController.moveDeal);
router.delete('/:id',        dealBoardController.deleteDeal);

export default router;
