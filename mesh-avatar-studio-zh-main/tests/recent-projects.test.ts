import { afterEach, expect, test, vi } from 'vitest';
import { addRecent, readRecent, saveRecent, RECENT_KEY, type RecentProject } from '../src/editor/recent-projects';

afterEach(() => vi.unstubAllGlobals());
const entry = (n: number): RecentProject => ({ id: `server:${n}`, kind: 'server', name: `project-${n}`, serverName: `project-${n}`, relativePath: `projects/project-${n}`, lastOpened: new Date(n * 1000).toISOString() });
test('history deduplicates most-recent-first, caps at ten, and tolerates malformed or unavailable storage', () => {
  let recent: RecentProject[] = [];
  for (let n = 0; n < 15; n++) recent = addRecent(recent, entry(n));
  expect(recent).toHaveLength(10); expect(recent[0].name).toBe('project-14');
  recent = addRecent(recent, entry(7)); expect(recent[0].name).toBe('project-7'); expect(recent.filter(item => item.id === 'server:7')).toHaveLength(1);
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
  saveRecent(recent); expect(readRecent()).toEqual(recent);
  storage.set(RECENT_KEY, '{bad json'); expect(readRecent()).toEqual([]);
  storage.set(RECENT_KEY, JSON.stringify([null, { name: 'bad' }, entry(1)])); expect(readRecent()).toEqual([entry(1)]);
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  expect(readRecent()).toEqual([]); expect(() => saveRecent(recent)).not.toThrow();
});
