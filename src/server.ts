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
import config from './config';
import { initSyncScheduler } from './schedulers/sync.scheduler';
import { initCleanupScheduler } from './schedulers/cleanup.scheduler';

const app: Application = express();
const httpServer = createServer(app);

// ========================================
// ENHANCED REQUEST LOGGING
// ========================================
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n📨 [${timestamp}] ${req.method} ${req.path}`);
  console.log(`   Origin: ${req.headers.origin || 'None'}`);
  console.log(`   Authorization: ${req.headers.authorization ? 'Present ✓' : 'Missing ✗'}`);
  console.log(`   Content-Type: ${req.headers['content-type'] || 'None'}`);
  next();
});

// Connect to MongoDB
connectDB();

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// Webhook route (must be BEFORE CORS for raw body)
app.use('/api/webhooks', webhookRoute);

// ========================================
// FIXED CORS CONFIGURATION
// ========================================
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    const allowedOrigins = config.corsOrigin.split(',').map((o: string) => o.trim());

    if (!origin) {
      console.log('   ⚠️  CORS: No origin (allowed)');
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      console.log(`   ✅ CORS: Origin allowed - ${origin}`);
      return callback(null, true);
    }

    if (config.env === 'development') {
      console.log(`   ✅ CORS: Dev mode allowed - ${origin}`);
      return callback(null, true);
    }

    console.log(`   ❌ CORS: Blocked - ${origin}`);
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

console.log('\n🔧 Server Configuration:');
console.log('   CORS Origins:', config.corsOrigin);
console.log('   Environment:', config.env);
console.log('   Port:', config.port);

app.use(cookieParser());

// ========================================
// HEALTH CHECK - Enhanced for debugging
// ========================================
app.get('/health', (req, res) => {
  console.log('   ✅ Health check endpoint hit');
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    env: config.env,
    corsOrigin: config.corsOrigin
  });
});

// Add a test endpoint for the exact sync route
app.post('/api/appointments/sync/google-calendar/test', (req, res) => {
  console.log('   ✅ TEST ENDPOINT HIT - Route is accessible!');
  res.json({ message: 'Route works! Now check auth middleware.' });
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
    console.log('\n🚀 ================================');
    console.log(`   Server running on http://localhost:${config.port}`);
    console.log(`   Health: http://localhost:${config.port}/health`);
    console.log(`   API: http://localhost:${config.port}/api`);
    console.log('   ================================\n');
  });
}

export default app;