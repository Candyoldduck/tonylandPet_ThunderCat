import { dismissGuide, samplePresent, sampleSkipReason } from './sample';
import { expect, test } from '@playwright/test';

test('renders the data-driven engine without browser errors', async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await dismissGuide(page);
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/shell.png' });
  expect(errors).toEqual([]);
});
