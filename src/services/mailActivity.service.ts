class MailActivityService {
  private readonly lastMailboxAccessAt = new Map<string, number>();

  recordMailboxAccess(userId: string): void {
    if (!userId) return;
    this.lastMailboxAccessAt.set(userId, Date.now());
  }

  clearUser(userId: string): void {
    this.lastMailboxAccessAt.delete(userId);
  }

  isMailboxActive(userId: string, windowMs: number): boolean {
    const lastSeenAt = this.lastMailboxAccessAt.get(userId);
    if (!lastSeenAt) return false;

    if (Date.now() - lastSeenAt > windowMs) {
      this.lastMailboxAccessAt.delete(userId);
      return false;
    }

    return true;
  }

  getActiveMailboxUserIds(windowMs: number): string[] {
    const now = Date.now();
    const active: string[] = [];

    for (const [userId, lastSeenAt] of this.lastMailboxAccessAt.entries()) {
      if (now - lastSeenAt <= windowMs) {
        active.push(userId);
      } else {
        this.lastMailboxAccessAt.delete(userId);
      }
    }

    return active;
  }
}

export const mailActivityService = new MailActivityService();
export default mailActivityService;