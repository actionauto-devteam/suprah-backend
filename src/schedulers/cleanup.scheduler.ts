import cron from 'node-cron';
import appointmentService from '../services/appointment.service';

export const initCleanupScheduler = () => {
  // Run cleanup at 2 AM daily
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('Running appointment duplicate cleanup...');
      
      // Remove duplicate appointments
      const appointmentsRemoved = await appointmentService.removeDuplicateAppointments();
      
      console.log(`✓ Cleanup completed - Removed ${appointmentsRemoved} duplicate appointments`);
    } catch (error) {
      console.error('Cleanup scheduler error:', error);
    }
  });

  console.log('✓ Cleanup scheduler initialized - Runs daily at 2 AM');
};