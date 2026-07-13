import TimeLog from '../models/TimeLog.model';

export interface ShiftStatus {
    isOnShift: boolean;
    isOnBreak: boolean;
}

export async function getShiftStatusForActor(userId: any): Promise<ShiftStatus> {
    const lookbackStart = new Date();
    lookbackStart.setDate(lookbackStart.getDate() - 2);
    lookbackStart.setHours(0, 0, 0, 0);

    const logs = await TimeLog.find({
        userId,
        timestamp: { $gte: lookbackStart },
    }).sort({ timestamp: 1 }).lean();

    let isOnShift = false;
    let shiftStartedAt: Date | null = null;
    for (const log of logs) {
        if (log.type === 'time-in') {
            isOnShift = true;
            shiftStartedAt = log.timestamp;
        } else if (log.type === 'time-out') {
            isOnShift = false;
            shiftStartedAt = null;
        }
    }

    const sessionLogs = shiftStartedAt
        ? logs.filter((l) => new Date(l.timestamp) >= shiftStartedAt!)
        : logs;
    const breakIns = sessionLogs.filter((l) => l.type === 'break-in').length;
    const breakOuts = sessionLogs.filter((l) => l.type === 'break-out').length;
    const isOnBreak = breakIns > breakOuts;

    return { isOnShift, isOnBreak };
}
