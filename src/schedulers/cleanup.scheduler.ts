import cron from 'node-cron';
import appointmentService from '../services/appointment.service';
import conversationService from '../services/conversation.service';

export function initCleanupScheduler() {
  // Run cleanup every day at 2 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('[Cleanup] Running automated cleanup...');
    
    try {
      const appointmentsRemoved = await appointmentService.removeDuplicateAppointments();
      const conversationsRemoved = await conversationService.removeDuplicateConversations();
      
      console.log(`[Cleanup] Removed ${appointmentsRemoved} duplicate appointments`);
      console.log(`[Cleanup] Removed ${conversationsRemoved} duplicate conversations`);
    } catch (error) {
      console.error('[Cleanup] Cleanup failed:', error);
    }
  });
  
  console.log('[Cleanup] Automated cleanup scheduler initialized');
}