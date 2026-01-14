import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { ApiError } from '../utils/ApiError';

const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const validSchema = Joi.compile(schema);
  
  const { value, error } = validSchema.validate({
    body: req.body,
    query: req.query,
    params: req.params,
    cookies: req.cookies,
  }, {
    abortEarly: false,
    allowUnknown: true,
  });

  if (error) {
    const errorMessage = error.details.map((details) => details.message).join(', ');
    return next(new ApiError(400, errorMessage));
  }
  Object.assign(req, {
    body: value.body,
    query: value.query,
    params: value.params,
    cookies: value.cookies,
  });
  return next();
};

export default validate;
