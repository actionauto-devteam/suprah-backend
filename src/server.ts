import express, { Application } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { setupSocket } from './socket';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import connectDB from './config/db';
import routes from './routes';
import webhookRoute from './routes/webhook.route';
import { errorHandler } from './middleware/error.middleware';
import leadRoutes from './routes/lead.route';
import config from './config';
import { initSyncScheduler } from './schedulers/sync.scheduler';
import { initCleanupScheduler } from './schedulers/cleanup.scheduler';



const app: Application = express();
const httpServer = createServer(app);

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.path} | Origin: ${req.headers.origin || 'None'}`);
  next();
});

// Any other middleware...

// Connect to MongoDB
connectDB();

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// Add support for XML bodies (required for ADF emails)
app.use(express.text({ type: ['application/xml', 'text/xml'] }));

// Webhook route...
app.use('/api/webhooks', webhookRoute);

// ========================================
// FIXED CORS CONFIGURATION
// ========================================
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Parse allowed origins from config (comma-separated)
    const allowedOrigins = config.corsOrigin.split(',').map((o: string) => o.trim());

    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) {
      console.log('⚠️ CORS ALLOWED (No Origin)');
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      // console.log('✅ CORS ALLOWED:', origin); // Optional: Uncomment to reduce noise if needed, but useful for debugging
      return callback(null, true);
    }

    // In development, allow all origins
    if (config.env === 'development') {
      console.log('⚠️ CORS ALLOWED (Dev Mode):', origin);
      return callback(null, true);
    }

    // Origin not allowed
    console.log('❌ CORS BLOCKED:', origin);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
};

app.use(cors(corsOptions));

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: corsOptions
});

setupSocket(io);

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

  httpServer.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

export default app;