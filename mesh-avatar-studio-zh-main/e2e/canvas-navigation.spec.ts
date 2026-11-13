import { test, expect, type Page } from '@playwright/test';
import { dismissGuide, samplePresent, sampleSkipReason } from './sample';

test.beforeEach(async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  await page.goto('/'); await dismissGuide(page);
  await expect(page.getByTestId('preview-status')).toHaveAttribute('data-state', 'ready');
  await expect.poll(async () => Number(await page.getByTestId('editor').getAttribute('data-scale'))).toBeLessThan(1);
});
async function view(page: Page) {
  return page.getByTestId('editor').evaluate(element => ({ scale: Number(element.dataset.scale), x: Number(element.dataset.offsetX), y: Number(element.dataset.offsetY) }));
}
async function wheel(page: Page, options: { deltaX?: number; deltaY: number; ctrlKey?: boolean; metaKey?: boolean; deltaMode?: number }) {
  return page.getByTestId('editor').evaluate((element, options) => {
    const rect = element.getBoundingClientRect();
    return !element.dispatchEvent(new WheelEvent('wheel', { ...options, clientX: rect.left + 190, clientY: rect.top + 230, bubbles: true, cancelable: true }));
  }, options);
}
test('pinch keeps its cursor anchor, two-finger scrolling pans, and mouse mode persists', async ({ page }) => {
  const first = await view(page);
  expect(await wheel(page, { deltaX: 12.5, deltaY: 25.5 })).toBe(true);
  await expect.poll(async () => (await view(page)).x).toBeCloseTo(first.x - 12.5);
  const panned = await view(page); expect(panned.scale).toBe(first.scale); expect(panned.y).toBeCloseTo(first.y - 25.5);
  expect(await wheel(page, { deltaY: -200, ctrlKey: true })).toBe(true);
  await expect.poll(async () => (await view(page)).scale).toBeCloseTo(first.scale * Math.exp(0.2));
  const zoomed = await view(page);
  expect((190 - zoomed.x) / zoomed.scale).toBeCloseTo((190 - panned.x) / panned.scale);
  expect((230 - zoomed.y) / zoomed.scale).toBeCloseTo((230 - panned.y) / panned.scale);
  await wheel(page, { deltaY: -3, deltaMode: 1 }); await expect.poll(async () => (await view(page)).scale).toBeCloseTo(zoomed.scale * Math.exp(0.048));
  await page.getByRole('combobox', { name: 'Mouse wheel', exact: true }).selectOption('pan');
  const before = await view(page); await wheel(page, { deltaY: 120 }); await expect.poll(async () => (await view(page)).y).toBeCloseTo(before.y - 120);
  expect((await view(page)).scale).toBe(before.scale);
  await wheel(page, { deltaY: -40, metaKey: true }); await expect.poll(async () => (await view(page)).scale).toBeGreaterThan(before.scale);
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Mouse wheel', exact: true })).toHaveValue('pan');
});
test('Safari gesture events zoom from their starting scale without accumulating changes', async ({ page }) => {
  const initial = await view(page);
  const results = await page.getByTestId('editor').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [['gesturestart', 1], ['gesturechange', 1.5], ['gesturechange', 2], ['gestureend', 2]].map(([name, scale]) => {
      const event = new Event(String(name), { cancelable: true });
      Object.assign(event, { scale, clientX: rect.left + 190, clientY: rect.top + 230 });
      const cancelled = !element.dispatchEvent(event);
      if (name === 'gesturechange' && scale === 2) element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, cancelable: true }));
      return cancelled;
    });
  });
  expect(results).toEqual([true, true, true, true]);
  await expect.poll(async () => (await view(page)).scale).toBeCloseTo(initial.scale * 2);
  const after = await view(page); expect((190 - after.x) / after.scale).toBeCloseTo((190 - initial.x) / initial.scale);
});
test('empty-space drag, zoom buttons, shortcuts, limits and part fitting keep rig edits untouched', async ({ page }) => {
  const initial = await view(page), canvas = page.getByTestId('editor'), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 12, box.y + 12); await page.mouse.down(); await page.mouse.move(box.x + 44, box.y + 34); await page.mouse.up();
  await expect.poll(async () => (await view(page)).x).toBeCloseTo(initial.x + 32);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByTestId('zoom-value').click(); await expect(page.getByTestId('zoom-value')).toHaveText('100%');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(page.getByTestId('zoom-value')).toHaveText('125%');
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await expect(page.getByTestId('zoom-value')).toHaveText('100%');
  await canvas.focus(); await page.keyboard.press('Control+Equal'); await expect(page.getByTestId('zoom-value')).toHaveText('125%');
  await page.keyboard.press('Control+-'); await expect(page.getByTestId('zoom-value')).toHaveText('100%');
  await page.keyboard.press('Meta+0'); await expect.poll(async () => (await view(page)).scale).toBeCloseTo(initial.scale);
  await page.keyboard.press('Meta+1'); await expect(page.getByTestId('zoom-value')).toHaveText('100%');
  await page.getByTestId('part-mouth').click(); await page.getByRole('button', { name: 'Fit selected part', exact: true }).click();
  expect((await view(page)).scale).toBeGreaterThan(2); const fitted = await view(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click(); await page.getByTestId('part-mouth').dblclick();
  await expect.poll(async () => (await view(page)).scale).toBeCloseTo(fitted.scale);
  await wheel(page, { deltaY: -100000, ctrlKey: true }); await expect(page.getByTestId('zoom-value')).toHaveText('1600%');
  await wheel(page, { deltaY: 100000, ctrlKey: true }); await expect(page.getByTestId('zoom-value')).toHaveText('10%');
  await page.getByTestId('part-head').click(); const field = page.getByRole('spinbutton', { name: 'head.cx', exact: true }); await field.focus();
  const preserved = await view(page);
  expect(await field.evaluate(element => { const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  expect(await view(page)).toEqual(preserved); await expect(field).toHaveValue('615'); await expect(page.getByTestId('stale-banner')).toHaveCount(0);
});
