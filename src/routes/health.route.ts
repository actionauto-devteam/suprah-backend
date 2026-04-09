import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import config from '../config';
import logger from '../utils/logger';

const router = Router();

/**
 * @route   GET /healthz
 * @desc    Liveness probe - is the process running?
 */
router.get('/healthz', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/**
 * @route   GET /readyz
 * @desc    Readiness probe - are dependencies connected?
 */
router.get('/readyz', async (req: Request, res: Response) => {
  const health: any = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      mongodb: 'unknown',
      redis: 'unknown'
    }
  };

  let isReady = true;

  // 1. Check MongoDB Connection
  try {
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const state = mongoose.connection.readyState;
    if (state === 1) {
      health.services.mongodb = 'connected';
    } else {
      health.services.mongodb = 'disconnected';
      isReady = false;
    }
  } catch (err) {
    logger.error(err, 'Health check failed for MongoDB');
    health.services.mongodb = 'error';
    isReady = false;
  }

  // 2. Check Redis Connection (if enabled)
  if (config.redis.enabled) {
    try {
      const redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: 1000,
      });
      
      await redis.ping();
      health.services.redis = 'connected';
      await redis.quit();
    } catch (err) {
      logger.error(err, 'Health check failed for Redis');
      health.services.redis = 'disconnected';
      isReady = false;
    }
  } else {
    health.services.redis = 'disabled';
  }

  if (isReady) {
    res.status(200).json(health);
  } else {
    // 503 Service Unavailable tells Load Balancers/Docker this node is not ready
    res.status(503).json(health);
  }
});

export default router;
