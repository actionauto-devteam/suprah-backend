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

// Mock json2csv globally to prevent missing module errors during test runs
jest.mock('json2csv', () => ({
    Parser: jest.fn().mockImplementation(() => ({
        parse: jest.fn().mockReturnValue('csv,data')
    }))
}), { virtual: true });

// Mock environment variables
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_123';
process.env.CLERK_SECRET_KEY = 'sk_test_123';

// --- DATABASE SECURITY GATEKEEPER ---
// We strictly forbid running tests against Cloud Atlas to prevent accidental data loss.
const MONGODB_URI = process.env.TEST_MONGODB_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test';
const isAtlas = MONGODB_URI.includes('mongodb+srv') || MONGODB_URI.includes('mongodb.net');

if (isAtlas && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
    console.error('\n\n🚨 FATAL ERROR: DATABASE SECURITY BREACH PREVENTED');
    console.error('--------------------------------------------------');
    console.error('Jest is attempting to connect to a Cloud Atlas cluster.');
    console.error('To protect your data, the test suite has been terminated.');
    console.error('To run tests safely, use a local MongoDB instance or set');
    console.error('ALLOW_REMOTE_TEST_DB=true if you are 100% sure.\n\n');
    process.exit(1); 
}
// ------------------------------------

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';

// Connection logic
beforeAll(async () => {
    jest.setTimeout(600 * 1000); 
    if (mongoose.connection.readyState === 0) {
        console.log(`[TEST-SETUP] Connecting to SAFE test database: ${MONGODB_URI.replace(/\/\/.*@/, '//****:****@')}`);
        await mongoose.connect(MONGODB_URI);
    }
});

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
    }
});

// --- MASS DELETION SAFETY GATE ---
// Intercept all deleteMany calls to prevent accidental wipes of non-test databases.
const originalDeleteMany = mongoose.Model.deleteMany;
mongoose.Model.deleteMany = function (this: mongoose.Model<any>, filter: any, options?: any) {
    const dbName = mongoose.connection.name;
    const isSafeDb = dbName && (dbName === 'action-auto-test' || dbName.toLowerCase().includes('test'));
    
    // If filter is empty OR includes everything, and we're not in a safe test DB, BLOCK IT.
    const isMassDelete = !filter || Object.keys(filter).length === 0;
    
    if (isMassDelete && !isSafeDb) {
        const errorMsg = `🚨 SECURITY BLOCK: Mass-deletion (deleteMany({})) attempted on database "${dbName}". This is forbidden to protect data. Please use targeted deletions (e.g., by ID).`;
        console.error(`\n${errorMsg}\n`);
        throw new Error(errorMsg);
    }
    // @ts-ignore - Mongoose types for internal Model methods can be tricky with .apply
    return originalDeleteMany.apply(this, [filter, options]);
} as any;
// ---------------------------------


const clearMongooseRegistry = (): void => {
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

    // 🔒 DATA PROTECTION: Automatic collection cleanup has been DISABLED to prevent accidental wipes.
    // If you need a clean state for a specific test, please manage your data manually within that test.
    /*
    if (mongoose.connection.readyState !== 0) {
        const dbName = mongoose.connection.name;
        const isSafeDb = dbName === 'action-auto-test' || dbName.includes('test');
        
        if (!isSafeDb && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
            console.error(`\n🚨 CRITICAL ERROR: Cleanup failed. Database name "${dbName}" is not explicitly a test database.\n`);
            return;
        }

        const collections = mongoose.connection.collections;
        for (const key in collections) {
            await collections[key].deleteMany({});
        }
    }
    */
});
