import {
  AI_HANDOFF_TOPIC_KEYS,
  aiHandoffTopicLabel,
  cleanAiHandoffTopicTeams,
  guessAiHandoffTopic,
  normalizeAiHandoffTopic,
} from '../../src/constants/aiHandoffTopics';

describe('AI handoff topics', () => {
  it('reads the topic the AI wrote, in any common spelling', () => {
    expect(normalizeAiHandoffTopic('availability')).toBe('availability');
    expect(normalizeAiHandoffTopic(' Trade-In ')).toBe('trade_in');
    expect(normalizeAiHandoffTopic('test drive')).toBe('appointment');
    expect(normalizeAiHandoffTopic('Video')).toBe('media');
    expect(normalizeAiHandoffTopic('callback')).toBe('person');
    expect(normalizeAiHandoffTopic('weather')).toBeNull();
    expect(normalizeAiHandoffTopic(undefined)).toBeNull();
  });

  it('guesses the topic from the words when the AI did not name one', () => {
    expect(guessAiHandoffTopic('confirm trim availability')).toBe('availability');
    expect(guessAiHandoffTopic('Is the Tacoma still on the lot?')).toBe('availability');
    expect(guessAiHandoffTopic('Customer asked about monthly payments and credit')).toBe('financing');
    expect(guessAiHandoffTopic('wants a payoff quote for their trade-in')).toBe('trade_in');
    expect(guessAiHandoffTopic('needs a shipping quote to Texas')).toBe('shipping');
    expect(guessAiHandoffTopic('asked for a walk-around video')).toBe('media');
    expect(guessAiHandoffTopic('wants to book a test drive Saturday')).toBe('appointment');
    expect(guessAiHandoffTopic('what is your best price')).toBe('pricing');
    expect(guessAiHandoffTopic('please call me back')).toBe('person');
    expect(guessAiHandoffTopic('safety check unavailable or timed out')).toBe('other');
    expect(guessAiHandoffTopic('something unclear')).toBe('other');
    expect(guessAiHandoffTopic('relationship question')).toBe('other');
  });

  it('labels every topic for staff', () => {
    for (const key of AI_HANDOFF_TOPIC_KEYS) expect(aiHandoffTopicLabel(key)).toBeTruthy();
    expect(aiHandoffTopicLabel('availability')).toBe('Vehicle availability');
    expect(aiHandoffTopicLabel(null)).toBeNull();
  });

  it('keeps only known topics with a valid team id in the settings', () => {
    expect(cleanAiHandoffTopicTeams({
      availability: '6ab5447f9681d24059de7911',
      pricing: '',
      weather: '6ab5447f9681d24059de7911',
      financing: 'not-an-id',
    })).toEqual({ availability: '6ab5447f9681d24059de7911' });
    expect(cleanAiHandoffTopicTeams(null)).toEqual({});
  });
});
