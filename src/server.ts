import express, { Application } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { jwtStrategy } from './config/passport';
import connectDB from './config/db';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import config from './config';
import { initSyncScheduler } from './schedulers/sync.scheduler';

const app: Application = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = config.corsOrigin.split(',').map((o: string) => o.trim());
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      // For development, you might want to allow this, but restrictive for now
      // return callback(null, true); 
      // Strictly checking against allowed list:
      if (config.env === 'development') {
        return callback(null, true);
      }
      // Actually, let's just stick to the list or be permissive in dev if needed.
      // The simplest implementation matching previous behavior but dynamic:
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      } else {
        return callback(new Error('Not allowed by CORS'));
      }
    }
    return callback(null, true);
  },
  credentials: true
}));

// Simple implementation using map directly if we trust the input, but callback is safer for dynamic logic
// Let's use the simpler version matching the user's previous array style but dynamic
// Re-doing the replacement content to be cleaner and closer to original style but dynamic

app.use(cookieParser());

// Passport middleware
app.use(passport.initialize());
passport.use('jwt', jwtStrategy);

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
  // Initialize Scheduler
  initSyncScheduler();

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

export default app;
