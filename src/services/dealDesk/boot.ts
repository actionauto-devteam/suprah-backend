/**
 * Self-wiring boot: attaches the "/deal-desk" socket namespace as soon as
 * the shared socket.io server exists and starts the scheduler. Called from
 * dealDesk.routes.ts at import time, so no changes to server.ts are needed.
 */
import { getSocketIO } from '../../utils/socketEmitter';
import { registerDealDeskNamespace } from '../../socket/dealDesk.socket';
import { startDealDeskScheduler } from './scheduler';

let booted = false;

export function bootDealDesk() {
  if (booted) return;
  booted = true;

  const tryAttach = () => {
    try {
      const io = (getSocketIO as any)();
      if (io && typeof io.of === 'function') {
        registerDealDeskNamespace(io);
        return true;
      }
    } catch {
      /* not ready yet */
    }
    return false;
  };

  if (!tryAttach()) {
    const timer = setInterval(() => {
      if (tryAttach()) clearInterval(timer);
    }, 1000);
    (timer as any).unref?.();
  }
  startDealDeskScheduler();
}
