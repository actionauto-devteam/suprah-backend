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

beforeAll(async () => {
    // Check if we are already connected?
    if (mongoose.connection.readyState === 0) {
        const url = process.env.MONGODB_URI_TEST || 'mongodb+srv://Vercel-Admin-action-auto-app:x6YwIrGT6fCk2Gmu@action-auto-app.abdbk4i.mongodb.net/test-db?retryWrites=true&w=majority';
        await mongoose.connect(url);
    }
});

afterAll(async () => {
    // await mongoose.connection.dropDatabase(); // Be careful with this if using a shared cluster
    await mongoose.connection.close();
});

// Clear collections between tests
afterEach(async () => {
    // const collections = mongoose.connection.collections;
    // for (const key in collections) {
    //     await collections[key].deleteMany({});
    // }
});
