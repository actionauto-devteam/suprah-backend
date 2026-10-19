import {
  buildContextualFallback,
  detectFallbackKind,
  extractRequestedDay,
  extractRequestedTime,
  GENERIC_FALLBACK_MESSAGES,
  FallbackTranscriptEntry,
} from '../../src/utils/aiFallbackMessage';
import { validateOutboundMessage } from '../../src/utils/aiOutboundSafety';

const customer = (body: string): FallbackTranscriptEntry => ({ from: 'customer', body });
const ai = (body: string): FallbackTranscriptEntry => ({ from: 'ai', body });

describe('extractRequestedDay / extractRequestedTime', () => {
  it('pulls a weekday + date the customer asked for', () => {
    expect(extractRequestedDay('test drive for Friday, October 16th please')).toBe('Friday, October 16th');
    expect(extractRequestedDay('can I come in oct 18')).toBe('Oct 18');
    expect(extractRequestedDay('how about tomorrow')).toBe('tomorrow');
    expect(extractRequestedDay('is 10/16 ok')).toBe('10/16');
    expect(extractRequestedDay('just looking')).toBeNull();
  });

  it('pulls a single requested time', () => {
    expect(extractRequestedTime('can I come at 10:30am')).toBe('10:30 AM');
    expect(extractRequestedTime('around 3 pm works')).toBe('3 PM');
  });

  it('ignores time ranges like store hours instead of echoing them as the appointment time', () => {
    expect(extractRequestedTime("during Action Auto's open hours (10 AM–7 PM)")).toBeNull();
    expect(extractRequestedTime('anytime 1pm to 4pm')).toBeNull();
  });

  it('ignores multiple times rather than picking one', () => {
    expect(extractRequestedTime('either 10am or 2pm')).toBeNull();
  });
});

describe('detectFallbackKind', () => {
  it.each([
    ['I want to schedule a test drive Friday at 11am', 'test_drive_with_time'],
    ['Can I test drive it?', 'test_drive'],
    ['Can I come in tomorrow?', 'visit_with_time'],
    ['I want to stop by and see it', 'visit'],
    ['Is it still available?', 'availability'],
    ["What's the out the door price?", 'details'],
    ['Do you take trade ins?', 'details'],
    ['Can someone call me?', 'callback'],
    ['ok thanks', 'general'],
    ['', 'general'],
  ])('%s -> %s', (message, kind) => {
    expect(detectFallbackKind(message)).toBe(kind);
  });
});

describe('buildContextualFallback — scenario H: test drive with a specific date/time', () => {
  it("acknowledges Ms. Jen's exact test-drive request instead of the generic line", () => {
    const result = buildContextualFallback({
      transcript: [
        customer(
          "Shopper requested to schedule a test drive for Friday, October 16th during Action Auto's open hours (10 AM–7 PM). They did not provide a name before the conversation ended.",
        ),
      ],
    });
    expect(result.kind).toBe('test_drive_with_time');
    expect(result.text).toBe(
      'Thanks for your test drive request! A member of our team will follow up to confirm whether Friday, October 16th works.',
    );
    expect(result.text).not.toMatch(/10 AM|7 PM/);
  });

  it('includes a single clearly requested time and the vehicle when known', () => {
    const result = buildContextualFallback({
      transcript: [customer('Can I test drive it Saturday at 11am?')],
      vehicleLabel: '2023 Toyota Highlander',
    });
    expect(result.text).toBe(
      'Thanks for your test drive request for the 2023 Toyota Highlander! A member of our team will follow up to confirm whether Saturday at 11 AM works.',
    );
  });
});

describe('buildContextualFallback — never implies an unverified completed action', () => {
  const requests = [
    'I want to schedule a test drive Friday at 11am',
    'Can I test drive it?',
    'Can I come in tomorrow at 9am?',
    'I want to stop by and see it',
    'Is the Highlander still available?',
    'What is the price?',
    'Can someone call me?',
    'ok thanks',
  ];
  const COMPLETED_OR_IN_PROGRESS_CLAIMS =
    /\b(i'm confirming|i am confirming|i've|i have|confirmed|booked|scheduled for you|is set|locked? (it )?in|checking|i'm looping|right with you|on (it|the way)|reserved|on hold|available for you)\b/i;

  it.each(requests)('only promises a future follow-up, never a done or in-progress action: %s', (message) => {
    for (const vehicleLabel of [undefined, '2023 Toyota Highlander']) {
      const { text } = buildContextualFallback({ transcript: [customer(message)], vehicleLabel });
      expect(text).not.toMatch(COMPLETED_OR_IN_PROGRESS_CLAIMS);
      expect(text).toMatch(/will (follow up|get back|reach out)/i);
    }
  });

  it('applies to every generic fallback too', () => {
    for (const text of GENERIC_FALLBACK_MESSAGES) {
      expect(text).not.toMatch(COMPLETED_OR_IN_PROGRESS_CLAIMS);
      expect(validateOutboundMessage(text).ok).toBe(true);
    }
  });
});

describe('buildContextualFallback — safety and variety', () => {
  const messages = [
    'I want to schedule a test drive Friday at 11am',
    'Can I test drive it?',
    'Can I come in tomorrow at 9am?',
    'I want to stop by and see it',
    'Is the Highlander still available?',
    'What is the price and can I finance it with my trade in?',
    'Can someone call me?',
    'ok thanks',
  ];

  it.each(messages)('every template passes the outbound safety validator: %s', (message) => {
    for (const vehicleLabel of [undefined, '2022 Jeep Grand Cherokee 4XE']) {
      const result = buildContextualFallback({ transcript: [customer(message)], vehicleLabel });
      expect(validateOutboundMessage(result.text).ok).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(300);
    }
  });

  it('never claims a vehicle is available or quotes pricing/financing details', () => {
    for (const message of messages) {
      const { text } = buildContextualFallback({ transcript: [customer(message)], vehicleLabel: '2023 Toyota Highlander' });
      expect(text).not.toMatch(/\bis available\b|\bstill available\b|\bin stock\b|\$|\bprice|\bfinanc|\btrade/i);
    }
  });

  it('uses the latest customer message, not an older one', () => {
    const result = buildContextualFallback({
      transcript: [customer('Can I test drive it?'), ai('Sure!'), customer('Can someone call me?')],
    });
    expect(result.kind).toBe('callback');
  });

  it('does not repeat the exact fallback it already sent recently', () => {
    const first = buildContextualFallback({ transcript: [customer('Can I test drive it?')] });
    const second = buildContextualFallback({
      transcript: [customer('Can I test drive it?'), ai(first.text), customer('Can I test drive it?')],
    });
    expect(second.text).not.toBe(first.text);
    expect(validateOutboundMessage(second.text).ok).toBe(true);
  });

  it('rotates generic fallbacks and picks the least recently used when all were used', () => {
    const [a, b] = GENERIC_FALLBACK_MESSAGES;
    expect(buildContextualFallback({ transcript: [customer('hmm')] }).text).toBe(a);
    expect(buildContextualFallback({ transcript: [ai(a), customer('hmm')] }).text).toBe(b);
    expect(buildContextualFallback({ transcript: [ai(a), ai(b), customer('hmm')] }).text).toBe(a);
  });
});
