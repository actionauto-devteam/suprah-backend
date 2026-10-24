export const CONFIRM_KEYWORDS = new Set(["YES", "Y", "CONFIRM", "CONFIRMED", "OK", "OKAY"]);
export const RESCHEDULE_KEYWORDS = new Set(["NO", "N", "CANCEL", "RESCHEDULE", "CHANGE"]);
export const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT"]);
export const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);
export const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

export function normalizeSmsCommand(body: string): string {
  return (body || "").trim().toUpperCase().replace(/[.!?]+$/, "");
}

export function isSmsKeyword(body: unknown): boolean {
  const command = normalizeSmsCommand(String(body || ""));
  return [CONFIRM_KEYWORDS, RESCHEDULE_KEYWORDS, OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS, HELP_KEYWORDS].some((set) => set.has(command));
}
