import express, { Application } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { jwtStrategy } from './config/passport';
import connectDB from './config/db';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import config from './config';

const app: Application = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(cookieParser());

// Passport middleware
app.use(passport.initialize());
passport.use('jwt', jwtStrategy);

// API Routes
app.use('/api', routes);

// Global error handler
app.use(errorHandler);

// Only listen if this file is run directly (not imported)
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

export default app;
