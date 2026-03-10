import express, { Application } from 'express';
import { createServer } from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { setupSocket } from './socket';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import connectDB from './config/db';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import passport from './config/passport';
import config from './config';
import { initSyncScheduler } from './schedulers/sync.scheduler';
import { initCleanupScheduler } from './schedulers/cleanup.scheduler';

const app: Application = express();

// Use Helmet for secure HTTP headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin for images/sockets
  contentSecurityPolicy: config.env === 'production' ? undefined : false, // Disable CSP in dev to avoid blocking Vite/Hot Reload
}));
const httpServer = createServer(app);

// ========================================
// Request logging middleware
// ========================================
app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.path} | Origin: ${req.headers.origin || 'None'}`);
  next();
});

// ========================================
// Connect to MongoDB
// ========================================
connectDB();

// ========================================
// Body Parsers
// ========================================
app.use(express.json({
  limit: '50mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// XML body support (ADF emails)
app.use(express.text({ type: ['application/xml', 'text/xml'] }));

// ========================================
// Static file serving (proof-of-delivery images)
// ========================================
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ========================================
// CORS CONFIGURATION
// ========================================
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    const allowedOrigins = config.corsOrigin.split(',').map((o: string) => o.trim());

    // Allow requests without origin (Postman, mobile apps)
    if (!origin) {
      console.log('⚠️ CORS ALLOWED (No Origin)');
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    if (config.env === 'development') {
      console.log('⚠️ CORS ALLOWED (Dev Mode):', origin);
      return callback(null, true);
    }

    console.log('❌ CORS BLOCKED:', origin);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },

  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-impersonate-org-id'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
};

app.use(cors(corsOptions));

// ========================================
// Socket.IO
// ========================================
const io = new Server(httpServer, {
  cors: corsOptions
});

setupSocket(io);

console.log('✓ CORS configured with origins:', config.corsOrigin);
console.log('✓ Environment:', config.env);

app.use(cookieParser());
app.use(passport.initialize());

// ========================================
// Health Check
// ========================================
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ========================================
// API Routes
// ========================================
app.use('/api', routes);

// ========================================
// Global Error Handler
// ========================================
app.use(errorHandler);

// ========================================
// Server Start
// ========================================
if (require.main === module) {
  initSyncScheduler();
  initCleanupScheduler();

  httpServer.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

export default app;
