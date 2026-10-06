import { stripMessageFormatting } from '../../src/utils/messagePreview';

describe('stripMessageFormatting', () => {
  it('removes current and legacy highlight controls while preserving their text', () => {
    expect(
      stripMessageFormatting(
        '{highlight:#f4f5f7}Important{/highlight} {{highlight:#ffff00}}Legacy{{/highlight}}',
      ),
    ).toBe('Important Legacy');
  });
});
