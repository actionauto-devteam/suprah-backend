// Single source of truth for which TimeLog `note` strings mark an auto-clockout as
// seamlessly resumable (Resume Shift). Previously duplicated independently in
// crmTimeproof.controller.ts, generalTimeclock.controller.ts, and
// staleShiftAutoClockout.scheduler.ts — a new auto-clockout reason added to only one
// copy would silently break Resume-Shift eligibility for it in the others.
export const AUTO_CLOCKOUT_CLOSE_NOTES = [
  'Auto clock-out — device went idle/offline after rendering 8+ hours',
  'Auto clock-out — device went idle/offline for 30+ minutes',
  'Auto clock-out — idle 30+ minutes (staged idle escalation)',
  'Auto clock-out — idle 35+ minutes (local fallback — backend unreachable)',
];
