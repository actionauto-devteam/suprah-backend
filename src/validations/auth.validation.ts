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
  body: Joi.object().keys({
    refreshToken: Joi.string(),
  }),
  cookies: Joi.object().keys({
    refreshToken: Joi.string(),
  }).unknown(true),
};

const forgotPassword = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
  }),
};

const resetPassword = {
  body: Joi.object().keys({
    token: Joi.string().required(),
    password: Joi.string().required().min(8),
  }),
};

export default {
  register,
  login,
  refreshTokens,
  forgotPassword,
  resetPassword,
};
