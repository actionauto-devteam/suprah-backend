import Joi from 'joi';

const register = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().min(8),
    role: Joi.string().valid('user', 'admin'),
  }),
};

const login = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required(),
  }),
};

const refreshTokens = {
    cookies: Joi.object().keys({
      refreshToken: Joi.string().required(),
    }).unknown(true),
};

export default {
  register,
  login,
  refreshTokens,
};
