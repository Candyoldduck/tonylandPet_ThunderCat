import { expect, test } from '@playwright/test';
test('opens the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mesh Avatar Studio' })).toBeVisible();
});
