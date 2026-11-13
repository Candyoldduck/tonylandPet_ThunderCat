import { dismissGuide, samplePresent, sampleSkipReason } from './sample';
import { expect, test } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixture from '../samples/miko-qipao/rig.json' with { type: 'json' };

test('dragging a head handle synchronizes the inspector', async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  await page.goto('/');
  await dismissGuide(page);
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  const canvas = page.getByTestId('editor');
  await expect(canvas).toHaveAttribute('data-scale', /0\./);
  await page.screenshot({ path: 'docs/screenshots/all-groups.png' });
  const box = (await canvas.boundingBox())!;
  const scale = Number(await canvas.getAttribute('data-scale'));
  const x = box.x + Number(await canvas.getAttribute('data-offset-x')) + 615 * scale;
  const y = box.y + Number(await canvas.getAttribute('data-offset-y')) + 400 * scale;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20 * scale, y + 15 * scale, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'head.cx', exact: true })).toHaveValue('635');
  await expect(page.getByRole('spinbutton', { name: 'head.cy', exact: true })).toHaveValue('415');
  await page.screenshot({ path: 'docs/screenshots/head-drag.png' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'head.cx', exact: true })).toHaveValue('615');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'head.cx', exact: true })).toHaveValue('635');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save rig', exact: true }).click();
  const download = await downloadPromise;
  const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(saved.head.cx).toBe(635);
  expect(saved.head.cy).toBe(415);
  expect(saved.eyes[0].top).toEqual(fixture.eyes[0].top);
});

test('opens a validated rig and rejects malformed files without replacing the project', async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  await page.goto('/');
  await dismissGuide(page);
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  const edited = structuredClone(fixture);
  edited.head.cx = 645;
  await page.getByLabel('Open rig file', { exact: true }).setInputFiles({ name: 'rig.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(edited)) });
  await page.getByTestId('part-head').click();
  await expect(page.getByRole('spinbutton', { name: 'head.cx', exact: true })).toHaveValue('645');
  await page.getByLabel('Open rig file', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1}') });
  await expect(page.getByRole('alert')).toContainText('rig.image');
  await expect(page.getByRole('spinbutton', { name: 'head.cx', exact: true })).toHaveValue('645');
});

test('rebuilds from cached assets, marks cut-outs stale, and sweeps angles', async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  const assets: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/miko-qipao/')) assets.push(request.url());
  });
  await page.goto('/');
  await dismissGuide(page);
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  const count = assets.length;
  const canvas = page.getByTestId('preview');
  const revision = Number(await canvas.getAttribute('data-revision'));
  await page.getByRole('button', { name: 'Pause idle motion', exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-revision'))).toBeGreaterThan(revision);
  await page.getByRole('slider', { name: 'Turn left/right', exact: true }).focus();
  await page.getByRole('slider', { name: 'Turn left/right', exact: true }).press('End');
  await page.getByTestId('part-eyes').click();
  await page.getByText(`1 · Opening (${fixture.eyes[0].opening.length})`, { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'eyes.0.opening.0.0', exact: true }).fill('451');
  const stale = page.getByTestId('stale-banner');
  await expect(stale).toContainText('The sample is read-only. To continue editing, copy it into a project.');
  await expect(stale.getByRole('button', { name: 'Copy and continue editing', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await canvas.getAttribute('data-revision'))).toBeGreaterThan(revision + 1);
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  expect(assets.length).toBe(count);
  await page.screenshot({ path: 'docs/screenshots/stale.png' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stale).toHaveCount(0);
  await page.getByRole('button', { name: 'Sweep angles', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop sweep' })).toBeVisible();
  for (let frame = 0; frame < 3; frame++) {
    await page.waitForTimeout(650);
    await page.screenshot({ path: `docs/screenshots/stress-${frame}.png` });
  }
  await page.getByRole('button', { name: 'Stop sweep', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sweep angles', exact: true })).toBeVisible();
});

test('opens a local project folder without the installed sample', async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  await page.route('**/miko-qipao/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('.png')) return route.fulfill({ status: 404, body: '' });
    return route.continue();
  });
  await page.goto('/');
  await dismissGuide(page);
  await expect(page.getByRole('heading', { name: 'Open a project', exact: true })).toBeVisible();
  await page.getByLabel('Open project folder files', { exact: true }).setInputFiles(fileURLToPath(new URL('../samples/miko-qipao/', import.meta.url)));
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('part-head').click();
  await expect(page.getByRole('spinbutton', { name: 'head.cx', exact: true })).toHaveValue('615');
});

test('a newly opened project establishes its own cut-out baseline', async ({ page }) => {
  test.skip(!samplePresent, sampleSkipReason);
  const directory = await mkdtemp(join(resolve('projects'), 'mesh-avatar-project-'));
  try {
    await cp(fileURLToPath(new URL('../samples/miko-qipao/', import.meta.url)), directory, { recursive: true });
    const rig = structuredClone(fixture);
    rig.eyes[0].opening[0][0] += 1;
    await writeFile(join(directory, 'rig.json'), JSON.stringify(rig));
    await page.goto('/');
    await dismissGuide(page);
    const folder = page.getByLabel('Open project folder files', { exact: true });
    await folder.setInputFiles(directory);
    await page.getByTestId('part-eyes').click();
    await page.getByText(`1 · Opening (${rig.eyes[0].opening.length})`, { exact: true }).click();
    const point = page.getByRole('spinbutton', { name: 'eyes.0.opening.0.0', exact: true });
    await expect(point).toHaveValue('447');
    await expect(page.locator('.stale')).toHaveCount(0);
    await point.fill('448');
    await expect(page.locator('.stale')).toContainText('This project is available in the project list.');
    await folder.setInputFiles(directory);
    await expect(page.locator('.stale')).toHaveCount(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
