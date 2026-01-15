import mongoose from 'mongoose';

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
