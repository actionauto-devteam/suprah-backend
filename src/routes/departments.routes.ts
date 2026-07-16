import { NextFunction, Request, Response, Router } from 'express';
import auth from '../middleware/auth.middleware';
import crmAuth from '../middleware/crmAuth.middleware';
import departmentController from '../controllers/department.controller';

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  auth()(req, res, (authError) => {
    if (!authError) return next();
    crmAuth()(req, res, next);
  });
});

router.get('/', departmentController.listActiveDepartments);

export default router;
