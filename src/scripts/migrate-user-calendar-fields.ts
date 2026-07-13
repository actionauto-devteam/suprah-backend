import mongoose from 'mongoose';
import User from '../models/User.model';
import config from '../config';

const migrateUserCalendarFields = async () => {
  try {
    console.log('🔄 Starting user calendar fields migration...');
    
    const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
    
    if (!databaseUri) {
      throw new Error('Database URI not found in config or environment variables');
    }
    
    await mongoose.connect(databaseUri);
    console.log('Connected to database');
    
    const result = await User.updateMany(
      { 'googleCalendar.connected': true },
      {
        $set: {
          'googleCalendar.watchChannelId': null,
          'googleCalendar.watchResourceId': null,
          'googleCalendar.watchExpiration': null,
        }
      }
    );
    
    console.log(`Updated ${result.modifiedCount} user records with new fields`);
    
    // List users with connected calendars
    const usersWithCalendar = await User.find(
      { 'googleCalendar.connected': true },
      'name email googleCalendar.connectedAt'
    );
    
    console.log(`\nUsers with Google Calendar connected: ${usersWithCalendar.length}`);
    usersWithCalendar.forEach(user => {
      console.log(`  - ${user.name} (${user.email})`);
    });
    
    console.log('\nMigration completed successfully');
    console.log('\nNOTE: Users will need to reconnect their Google Calendar to enable webhook notifications');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

// Run migration
migrateUserCalendarFields();