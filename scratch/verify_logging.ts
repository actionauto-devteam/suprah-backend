import pino from 'pino';
import path from 'path';
import fs from 'fs';

// Mock the environment to production
process.env.NODE_ENV = 'production';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test_audit'; // Safe mock

// Ensure log dir exists for the test
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

async function runTest() {
    console.log('--- STARTING LOG STREAM TEST ---');
    console.log('Expectation: JSON logs should appear below IMMEDIATELY.');
    
    // We import the real logger utility
    const { default: logger } = await import('../src/utils/logger');

    // Emit a few logs
    logger.info({ test: true }, 'Instant log test 1');
    logger.warn({ test: true, context: 'verification' }, 'Instant log test 2');
    
    // Test nested object serialization
    logger.error({ 
        err: new Error('Simulated connectivity issue'),
        req: { id: 'test-req-123', url: '/api/test' }
    }, 'Instant log test 3 (Error)');

    console.log('--- LOGS EMITTED ---');
    console.log('If you saw JSON objects above this line, the stdout stream is working.');
    
    // Wait a bit for workers to potentially initialize (though they are decoupled now)
    setTimeout(() => {
        console.log('--- TEST COMPLETE ---');
        process.exit(0);
    }, 2000);
}

runTest();
