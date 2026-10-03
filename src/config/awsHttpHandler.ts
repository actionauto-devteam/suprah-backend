import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'https';

// Shared HTTP handler for S3/R2 clients.
// Default maxSockets is 50, which the screen-capture upload/stream
// traffic exhausts, queueing all other R2 operations behind it.
export const sharedAwsHttpHandler = new NodeHttpHandler({
    httpsAgent: new HttpsAgent({
        keepAlive: true,
        maxSockets: 200,
    }),
    connectionTimeout: 5000,
    requestTimeout: 30000,
});