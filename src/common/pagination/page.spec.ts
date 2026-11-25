import { buildCursorPage } from './page.js';

describe('buildCursorPage', () => {
  it('uses the last returned item instead of the extra sentinel for nextCursor', () => {
    const page = buildCursorPage(
      [{ id: 'first' }, { id: 'second' }, { id: 'sentinel' }],
      2,
      (item) => `cursor:${item.id}`,
    );

    expect(page).toEqual({
      items: [{ id: 'first' }, { id: 'second' }],
      nextCursor: 'cursor:second',
    });
  });

  it('returns a null cursor when there is no following page', () => {
    expect(
      buildCursorPage([{ id: 'only' }], 2, (item) => `cursor:${item.id}`),
    ).toEqual({ items: [{ id: 'only' }], nextCursor: null });
  });
});
