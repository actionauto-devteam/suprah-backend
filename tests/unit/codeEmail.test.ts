import { codeEmail } from '../../src/utils/codeEmail';

describe('Branded code email', () => {
  const email = codeEmail({ brandName: 'Suprah.AI', heading: 'Your verification code', intro: 'Here is your code again.', code: '482913', minutesLeft: 12 });

  it('carries the Suprah.AI brand, the code, the expiry and the support contact', () => {
    expect(email.html).toContain('Suprah.AI');
    expect(email.html).toContain('482913');
    expect(email.html).toContain('This code expires in 12 minutes.');
    expect(email.html).toContain('support@suprahai.com');
    expect(email.html).toContain('#10b981');
    expect(email.text).toContain('Your code: 482913');
    expect(email.text).toContain('Suprah.AI');
  });

  it("a dealership name can't change the email's HTML", () => {
    const dealer = codeEmail({ brandName: 'A&B <Motors>', heading: 'Verify your email', intro: 'Welcome!', code: '111222', minutesLeft: 15 });
    expect(dealer.html).toContain('A&amp;B &lt;Motors&gt;');
    expect(dealer.html).not.toContain('<Motors>');
  });
});
