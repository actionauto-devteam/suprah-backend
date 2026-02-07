import express, { Application } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import connectDB from './config/db';
import routes from './routes';
import webhookRoute from './routes/webhook.route';
import { errorHandler } from './middleware/error.middleware';
import config from './config';
import { initSyncScheduler } from './schedulers/sync.scheduler';
import { initCleanupScheduler } from './schedulers/cleanup.scheduler';

const app: Application = express();

// Connect to MongoDB
connectDB();

// Middleware
// Webhook route must be mounted before body parser or handle its own parsing
app.use('/api/webhooks', webhookRoute);

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// ========================================
// FIXED CORS CONFIGURATION
// ========================================
app.use(cors({
  origin: (origin, callback) => {
    // Parse allowed origins from config (comma-separated)
    const allowedOrigins = config.corsOrigin.split(',').map((o: string) => o.trim());
    
    console.log('CORS Request from origin:', origin);
    console.log('Allowed origins:', allowedOrigins);
    
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) {
      console.log('No origin - allowing request');
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      console.log('Origin allowed:', origin);
      return callback(null, true);
    }
    
    // In development, allow all origins
    if (config.env === 'development') {
      console.log('Development mode - allowing origin:', origin);
      return callback(null, true);
    }
    
    // Origin not allowed
    console.log('CORS BLOCKED:', origin);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
}));

console.log('✓ CORS configured with origins:', config.corsOrigin);
console.log('✓ Environment:', config.env);

app.use(cookieParser());

// Health check route for Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// API Routes
app.use('/api', routes);

// Global error handler
app.use(errorHandler);

// Only listen if this file is run directly (not imported)
if (require.main === module) {
  initSyncScheduler();
  initCleanupScheduler();

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

export default app;