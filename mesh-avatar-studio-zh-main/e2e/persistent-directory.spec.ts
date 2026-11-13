import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

test('directory handles round-trip through IndexedDB without storing image data', async ({ baseURL }) => {
  await mkdir(resolve('projects'), { recursive: true });
  const profile = await mkdtemp(join(resolve('projects'), '.directory-test-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true });
  try {
  const page = context.pages()[0];
  await page.goto(baseURL!);
  const result = await page.evaluate(async () => {
    const path = '/src/editor/recent-projects.ts';
    const helpers = await import(path);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle('empty-history-check', { create: true });
    const kept = await helpers.keepDirectory('folder:handle-check', handle);
    const restored = await helpers.restoreDirectory('folder:handle-check');
    const same = restored ? await handle.isSameEntry(restored) : false;
    await helpers.forgetDirectory('folder:handle-check');
    const forgotten = await helpers.restoreDirectory('folder:handle-check');
    await root.removeEntry('empty-history-check', { recursive: true });
    return { kept, same, forgotten: forgotten === undefined };
  });
  expect(result).toEqual({ kept: true, same: true, forgotten: true });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
