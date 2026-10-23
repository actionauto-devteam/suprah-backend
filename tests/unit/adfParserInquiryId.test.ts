import { parseADF } from '../../src/utils/adfParser';

const adf = (prospectExtra: string) => `<?xml version="1.0"?>
<adf>
  <prospect status="new">
    ${prospectExtra}
    <vehicle interest="buy" status="used"><year>2022</year><make>Honda</make><model>Civic</model></vehicle>
    <customer><contact><name part="first">Pat</name><name part="last">Lee</name><email>pat@example.com</email><phone>385-503-5869</phone></contact><comments>Is it available?</comments></customer>
    <provider><name>CarFax</name></provider>
  </prospect>
</adf>`;

describe('ADF provider inquiry ids and request dates', () => {
  it('reads a single provider inquiry id with its source', async () => {
    const parsed = await parseADF(adf('<id sequence="1" source="CarFax">CF-123</id><requestdate>2026-10-22T09:28:00-06:00</requestdate>'));
    expect(parsed?.providerInquiryId).toBe('CF-123');
    expect(parsed?.providerInquiryIdSource).toBe('CarFax');
    expect(parsed?.requestDateProvided).toBe(true);
    expect(parsed?.requestDate).toBe('2026-10-22T09:28:00-06:00');
  });

  it('uses the lowest sequence when several ids are present', async () => {
    const parsed = await parseADF(adf('<id sequence="2" source="DealersCloud">DC-9</id><id sequence="1" source="CarFax">CF-123</id>'));
    expect(parsed?.providerInquiryId).toBe('CF-123');
    expect(parsed?.providerInquiryIdSource).toBe('CarFax');
  });

  it('reads a plain id without attributes', async () => {
    const parsed = await parseADF(adf('<id>XYZ-1</id>'));
    expect(parsed?.providerInquiryId).toBe('XYZ-1');
    expect(parsed?.providerInquiryIdSource).toBeUndefined();
  });

  it('ignores an empty id instead of mistaking its source for the id', async () => {
    const parsed = await parseADF(adf('<id source="CarFax"></id>'));
    expect(parsed?.providerInquiryId).toBeUndefined();
  });

  it('marks a missing request date while keeping the existing default value', async () => {
    const before = Date.now();
    const parsed = await parseADF(adf(''));
    expect(parsed?.requestDateProvided).toBe(false);
    expect(parsed?.providerInquiryId).toBeUndefined();
    expect(new Date(String(parsed?.requestDate)).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('keeps every existing parsed field', async () => {
    const parsed = await parseADF(adf('<id source="CarFax">CF-1</id>'));
    expect(parsed).toMatchObject({
      firstName: 'Pat',
      lastName: 'Lee',
      email: 'pat@example.com',
      phone: '385-503-5869',
      vehicle: expect.objectContaining({ year: '2022', make: 'Honda', model: 'Civic' }),
      comments: 'Is it available?',
      provider: 'CarFax',
      channel: 'adf',
    });
  });
});
