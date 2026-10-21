export const LAB_CONFIRM_KEYWORDS = new Set(["YES", "Y", "CONFIRM", "CONFIRMED", "OK", "OKAY"]);
export const LAB_RESCHEDULE_KEYWORDS = new Set(["NO", "N", "CANCEL", "RESCHEDULE", "CHANGE"]);
export const LAB_OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT"]);
export const LAB_OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);

export function normalizeLabSmsCommand(body: string): string {
  return (body || "").trim().toUpperCase().replace(/[.!?]+$/, "");
}
