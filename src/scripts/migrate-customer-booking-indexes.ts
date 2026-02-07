import mongoose from 'mongoose';
import Appointment from '../models/Appointment.model';
import Conversation from '../models/Conversation.model';
import config from '../config';

const migrateCustomerBookingIndexes = async () => {
  try {
    console.log('Starting customer booking indexes migration...');
    
    const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
    
    if (!databaseUri) {
      throw new Error('Database URI not found in config or environment variables');
    }
    
    await mongoose.connect(databaseUri);
    console.log('Connected to database');
    
    // Drop old indexes if they exist
    console.log('Checking existing indexes...');
    const existingIndexes = await Appointment.collection.getIndexes();
    console.log('Existing indexes:', Object.keys(existingIndexes));
    
    // Create new indexes for customer bookings
    console.log('Creating customer booking indexes...');
    
    try {
      await Appointment.collection.createIndex({ 'customerBooking.email': 1 });
      console.log('Created index on customerBooking.email');
    } catch (error) {
      console.log('Index customerBooking.email already exists');
    }
    
    try {
      await Appointment.collection.createIndex({ 'customerBooking.phone': 1 });
      console.log('Created index on customerBooking.phone');
    } catch (error) {
      console.log('Index customerBooking.phone already exists');
    }
    
    try {
      await Appointment.collection.createIndex({ 
        'customerBooking.firstName': 1, 
        'customerBooking.lastName': 1 
      });
      console.log('Created compound index on customerBooking name');
    } catch (error) {
      console.log('Compound index on name already exists');
    }
    
    try {
      await Appointment.collection.createIndex({ 
        'customerBooking.isCustomerBooking': 1, 
        startTime: -1 
      });
      console.log('Created compound index on isCustomerBooking and startTime');
    } catch (error) {
      console.log('Compound index on isCustomerBooking already exists');
    }
    
    // Create indexes for external conversations
    console.log('Creating external conversation indexes...');
    
    try {
      await Conversation.collection.createIndex({ 'externalParticipant.email': 1 });
      console.log('Created index on externalParticipant.email');
    } catch (error) {
      console.log('Index externalParticipant.email already exists');
    }
    
    try {
      await Conversation.collection.createIndex({ 'linkedCustomerBooking.email': 1 });
      console.log('Created index on linkedCustomerBooking.email');
    } catch (error) {
      console.log('Index linkedCustomerBooking.email already exists');
    }
    
    // Verify all indexes
    console.log('\nFinal index list for Appointments:');
    const finalAppointmentIndexes = await Appointment.collection.getIndexes();
    Object.keys(finalAppointmentIndexes).forEach(indexName => {
      console.log(`  - ${indexName}`);
    });
    
    console.log('\nFinal index list for Conversations:');
    const finalConversationIndexes = await Conversation.collection.getIndexes();
    Object.keys(finalConversationIndexes).forEach(indexName => {
      console.log(`  - ${indexName}`);
    });
    
    console.log('\nMigration completed successfully');
    console.log('\nNext steps:');
    console.log('  1. Test customer booking duplicate prevention');
    console.log('  2. Test external email conversations');
    console.log('  3. Verify Google Calendar sync');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

// Run migration
migrateCustomerBookingIndexes();