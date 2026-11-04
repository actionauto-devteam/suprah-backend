import { moneyFigures, moneyKeys, sameMoneyFigures } from '../../src/utils/aiMoneyAmounts';
import { buildMoneyAllowance, buildReplyAllowance, validateOutboundMessage } from '../../src/utils/aiOutboundSafety';
import { guardrailIssues } from '../../src/services/aiTrainingImportScreening';
import { strictInstructionIssues } from '../../src/services/aiTrainingSafetyGate';
import { evaluateCoachingRecord } from '../../src/services/aiCoachingAudit.service';

describe('money amounts an admin can allow', () => {
  it('finds every amount a manager needs to see', () => {
    expect(moneyFigures('$500 which is non-refundable, but goes towards the purchase of the vehicle.')).toEqual(['$500']);
    expect(moneyFigures('Our doc fee is $299. A $1,500.00 hold and 3.9% APR for 72 months on approved financing.')).toEqual(['$299', '$1,500.00', '3.9%', '72 months']);
    expect(moneyFigures('Bring 2 grand or 500 dollars.')).toEqual(['2 grand', '500 dollars']);
    expect(moneyFigures('We are open 9 to 7, six days a week, and the warranty lasts 12 months.')).toEqual([]);
    expect(moneyFigures('$500 now. Another $500 later.')).toEqual(['$500']);
  });

  it('reads the same amount the same way however it is written', () => {
    expect(moneyKeys('$1,500')).toEqual(['usd:1500']);
    expect(moneyKeys('1500 dollars')).toEqual(['usd:1500']);
    expect(moneyKeys('$1.5k')).toEqual(['usd:1500']);
    expect(moneyKeys('3.90%')).toEqual(['pct:3.9']);
    expect(moneyKeys('Call us any time.')).toEqual([]);
  });

  it('only matches a saved approval to the same amounts', () => {
    expect(sameMoneyFigures(['$500'], ['$500'])).toBe(true);
    expect(sameMoneyFigures(['$500', '3.9%'], ['3.9%', '$500'])).toBe(true);
    expect(sameMoneyFigures(['$500'], ['$400'])).toBe(false);
    expect(sameMoneyFigures(['$500'], ['$500', '$100'])).toBe(false);
    expect(sameMoneyFigures(undefined, ['$500'])).toBe(false);
    expect(sameMoneyFigures(['$500'], [])).toBe(false);
  });
});

describe('the final safety check with approved amounts', () => {
  const allowance = buildMoneyAllowance(['When customers ask about holding a vehicle, say we take a $500 deposit that goes toward the purchase price.'])!;

  it('builds an allowance only from notes that contain amounts', () => {
    expect(buildMoneyAllowance(['Ask for the best time to call.'])).toBeUndefined();
    expect(allowance.amounts).toEqual(['$500']);
    expect(allowance.keys).toEqual(['usd:500']);
    expect([...allowance.reasons].sort()).toEqual(['currency amount', 'price mention']);
  });

  it('lets the approved amount through and still blocks everything else', () => {
    const reply = 'We take a $500 deposit, and it goes toward the purchase price.';
    expect(validateOutboundMessage(reply).ok).toBe(false);
    expect(validateOutboundMessage(reply, allowance)).toEqual({ ok: true, reasons: [] });
    expect(validateOutboundMessage('We take a $400 deposit.', allowance).reasons).toContain('currency amount');
    expect(validateOutboundMessage('We take $500 now and $500/mo after.', allowance).reasons).toContain('financing/payment language');
    expect(validateOutboundMessage('We take a $500 deposit and 10% off.', allowance).reasons).toContain('percent-off');
    expect(validateOutboundMessage('The deposit is $500. Call 801-555-0100.', allowance).reasons).toContain('unexpected phone number');
    expect(validateOutboundMessage('A $500 deposit is guaranteed to hold it.', allowance).reasons).toContain('guaranteed-availability language');
    expect(validateOutboundMessage('Our price is the best in town.', allowance).reasons).toContain('price mention');
  });
});

describe('training checks with allowed amounts', () => {
  it('holds a Podium FAQ with a price unless amounts are allowed, and never allows promises', () => {
    const answer = '$500 which is non-refundable, but goes towards the purchase of the vehicle.';
    expect(guardrailIssues('answerOrInstruction', answer, 'knowledge').map((issue) => issue.code)).toEqual(['guardrail_figure']);
    expect(guardrailIssues('answerOrInstruction', answer, 'knowledge', { allowMoney: true })).toEqual([]);
    expect(guardrailIssues('answerOrInstruction', 'Everyone gets approved with a $500 deposit.', 'knowledge', { allowMoney: true }).map((issue) => issue.code)).toEqual(['guardrail_promise']);
  });

  it('lets coaching with allowed amounts pass, but not promises', () => {
    const text = 'Tell customers we take a $500 deposit that goes toward the price.';
    expect(strictInstructionIssues(text).map((issue) => issue.code)).toContain('guardrail_figure');
    expect(strictInstructionIssues(text, { allowMoney: true })).toEqual([]);
    expect(strictInstructionIssues('Tell customers a $500 deposit means guaranteed approval.', { allowMoney: true }).length).toBeGreaterThan(0);
  });

  it('the coaching audit honors an approval only when it matches the text', () => {
    const instruction = 'Tell customers we take a $500 deposit.';
    expect(evaluateCoachingRecord({ instruction }).passed).toBe(false);
    expect(evaluateCoachingRecord({ instruction, amountApproval: { amounts: ['$500'] } }).passed).toBe(true);
    expect(evaluateCoachingRecord({ instruction, amountApproval: { amounts: ['$400'] } }).passed).toBe(false);
  });
});

describe('approved Knowledge Base answers in the final check', () => {
  const allowance = buildReplyAllowance({
    moneyNotes: [],
    approvedAnswers: ['Our finance team can go over financing options. Call 801-555-0100, visit actionautoutah.com or email sales@actionautoutah.com.', 'We take trade-in vehicles.'],
  })!;

  it('allows the words, phone, website and email an approved answer uses, and nothing else', () => {
    expect(allowance.wordReasons!.sort()).toEqual(['financing/payment language', 'trade-in mention']);
    expect(allowance.amounts).toEqual([]);
    expect(validateOutboundMessage('Our finance team can walk you through financing, call 801-555-0100.', allowance).ok).toBe(true);
    expect(validateOutboundMessage('See actionautoutah.com/inventory, or email sales@actionautoutah.com.', allowance).ok).toBe(true);
    expect(validateOutboundMessage('Yes, we take trade-in vehicles!', allowance).ok).toBe(true);
    expect(validateOutboundMessage('Call 801-555-0199 instead.', allowance).reasons).toEqual(['unexpected phone number']);
    expect(validateOutboundMessage('Visit cheapcars.com today.', allowance).reasons).toEqual(['unexpected link']);
    expect(validateOutboundMessage('Email bob@gmail.com.', allowance).reasons).toContain('unexpected email address');
    expect(validateOutboundMessage('Financing starts at $199 a month.', allowance).reasons).toContain('currency amount');
    expect(validateOutboundMessage('Our discount is guaranteed.', allowance).reasons).toEqual(expect.arrayContaining(['discount/incentive language', 'guaranteed-availability language']));
  });

  it('without approved answers, nothing extra is allowed', () => {
    expect(buildReplyAllowance({ moneyNotes: [], approvedAnswers: [] })).toBeUndefined();
    expect(validateOutboundMessage('Our finance team can walk you through financing.').ok).toBe(false);
  });
});
