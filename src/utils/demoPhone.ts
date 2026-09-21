const DEMO_PHONE_PATTERN = /^\d{3}55501\d{2}$/;

export function isDemoPhone(phone: string): boolean {
  const digits = (phone || '').replace(/\D/g, '').slice(-10);
  return DEMO_PHONE_PATTERN.test(digits);
}

export function generateDemoPhone(): string {
  const line = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  return `+180155501${line}`;
}
