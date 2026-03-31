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

beforeAll(async () => {
    jest.setTimeout(60000); // Global timeout for all tests
    // Check if we are already connected?
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

// Clear collections between tests
afterEach(async () => {
    // const collections = mongoose.connection.collections;
    // for (const key in collections) {
    //     await collections[key].deleteMany({});
    // }
});
