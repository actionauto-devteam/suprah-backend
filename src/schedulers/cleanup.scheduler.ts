import cron from 'node-cron';
import logger from '../utils/logger';
import appointmentService from '../services/appointment.service';

export const initCleanupScheduler = () => {
  // Run cleanup at 2 AM daily
  cron.schedule('0 2 * * *', async () => {
    try {
      logger.info('Running appointment duplicate cleanup...');
      
      // Remove duplicate appointments
      const appointmentsRemoved = await appointmentService.removeDuplicateAppointments();
      
      logger.info(`✓ Cleanup completed - Removed ${appointmentsRemoved} duplicate appointments`);
    } catch (error) {
      logger.error({ error }, 'Cleanup scheduler error');
    }
  });

  logger.info('✓ Cleanup scheduler initialized - Runs daily at 2 AM');
};