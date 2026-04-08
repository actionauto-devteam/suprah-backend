import mongoose from 'mongoose';

// Mock Clerk SDK
jest.mock('@clerk/clerk-sdk-node', () => {
    return {
        clerkClient: {
            verifyToken: jest.fn().mockResolvedValue({
                sub: 'test_user_id',
                sid: 'test_session_id',
                org_id: 'test_org_id',
                org_role: 'org:admin'
            }),
            users: {
                getUser: jest.fn().mockResolvedValue({
                    id: 'test_user_id',
                    emailAddresses: [{ emailAddress: 'test@example.com' }],
                    firstName: 'Test',
                    lastName: 'User',
                    imageUrl: 'https://example.com/image.png'
                })
            }
        }
    };
});

// Mock environment variables
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_123';
process.env.CLERK_SECRET_KEY = 'sk_test_123';

// Connect to a test database (or mock)
// For now, we assume a local mongodb or we could use mongodb-memory-server if installed.
// Since we didn't install mongodb-memory-server, we will use a separate test db string.

jest.setTimeout(60000); // Global timeout for all tests
process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';

// Connection logic
beforeAll(async () => {
    jest.setTimeout(60000); 
    if (mongoose.connection.readyState === 0) {
        const url = process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test';
        await mongoose.connect(url);
    }
});

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
    }
});

const clearMongooseRegistry = () => {
    // 1. Clear Mongoose Model Registry
    Object.keys(mongoose.models).forEach(modelName => {
        delete mongoose.models[modelName];
    });

    // 2. Clear Mongoose Connection Model Registry (Crucial for isolated tests)
    if (mongoose.connection && (mongoose.connection as any).models) {
        Object.keys((mongoose.connection as any).models).forEach(modelName => {
            delete (mongoose.connection as any).models[modelName];
        });
    }
    
    // 3. Clear Mongoose Schema Registry
    const anyMongoose = mongoose as any;
    if (anyMongoose.modelSchemas) {
        Object.keys(anyMongoose.modelSchemas).forEach(schemaName => {
            delete anyMongoose.modelSchemas[schemaName];
        });
    }
};

// Double-Registry Purge: Clean state before AND after every test
beforeEach(async () => {
    clearMongooseRegistry();
});

afterEach(async () => {
    clearMongooseRegistry();

    // Clear collections (If connection is active)
    if (mongoose.connection.readyState !== 0) {
        const collections = mongoose.connection.collections;
        for (const key in collections) {
            await collections[key].deleteMany({});
        }
    }
});
