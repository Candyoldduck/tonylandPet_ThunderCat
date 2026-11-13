import { expect, test } from 'vitest';
import { Motion } from '../src/engine/motion.js';
import { kanaToMoras, sampleMoras, skippedKanaCharacters } from '../src/engine/kana.js';

test('held vowels share speech smoothing, preserve the preceding form for ん, and release', () => {
  const motion = new Motion([0, 0]); motion.mode = 'manual';
  const shapes = [];
  for (const vowel of ['a', 'i', 'o']) {
    motion.holdMouth(vowel);
    for (let i = 0; i < 30; i++) motion.update(1 / 60);
    shapes.push(motion.getLipSyncState());
  }
  expect(new Set(shapes.map(shape => `${shape.open.toFixed(2)},${shape.form}`)).size).toBe(3);
  motion.holdMouth('n'); for (let i = 0; i < 30; i++) motion.update(1 / 60);
  expect(motion.P.mouthOpen).toBeLessThan(0.001); expect(motion.P.mouthForm).toBe(0.6);
  motion.stopLipSync(); motion.update(1 / 60); expect(motion.getLipSyncState().active).toBe(false);
});

test('kana playback uses requested speed, loops, stops, and ignores unsupported text', () => {
  expect(kanaToMoras('アイ ウエオ').map(m => m.vowel)).toEqual(['a', 'i', 'n', 'u', 'e', 'o']);
  expect(skippedKanaCharacters('あA漢字いA')).toEqual(['A', '漢', '字']);
  const timeline = kanaToMoras('あいお', 1 / 4);
  expect(sampleMoras(timeline, 0.3)?.vowel).toBe('i');
  const motion = new Motion([0, 0]); motion.mode = 'manual';
  motion.speakKana('あいお', { speed: 4, loop: true });
  for (let i = 0; i < 120; i++) motion.update(1 / 60);
  expect(motion.getLipSyncState().active).toBe(true);
  motion.stopLipSync(); expect(motion.getLipSyncState().active).toBe(false);
  motion.speakKana('あ', { speed: 12 });
  for (let i = 0; i < 10; i++) motion.update(1 / 60);
  expect(motion.getLipSyncState().active).toBe(false);
  motion.speakKana('漢字', { loop: true }); expect(motion.getLipSyncState().active).toBe(false);
});
