import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import config from '../config';
import logger from '../utils/logger';

const router = Router();

router.get('/healthz', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

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

  try {
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
    res.status(503).json(health);
  }
});

export default router;
