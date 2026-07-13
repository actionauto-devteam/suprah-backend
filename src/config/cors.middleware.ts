import cors from 'cors';
import { Application } from 'express';
import config from '../config';

export const setupCORS = (app: Application): void => {
  const allowedOrigins = config.corsOrigin.split(',').map((o: string) => o.trim());

  console.log('Configuring CORS with origins:', allowedOrigins);

  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        console.log('CORS BLOCKED origin:', origin);
        console.log('Allowed origins:', allowedOrigins);
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
      'x-impersonate-org-id',
      'x-shop-session-id',
    ],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400, // 24 hours
    preflightContinue: false,
    optionsSuccessStatus: 204,
  };

  // Apply CORS middleware
  app.use(cors(corsOptions));

  // Handle preflight requests explicitly
  app.options('*', cors(corsOptions));

  console.log('✓ CORS middleware configured successfully');
};