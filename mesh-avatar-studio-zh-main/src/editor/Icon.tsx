const paths = {
  eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  hidden: 'M3 3l18 18 M9 5.5A12 12 0 0 1 12 5c7 0 10 7 10 7a18 18 0 0 1-4 4 M6 7c-3 2-4 5-4 5s3 7 10 7c2 0 3.5-.4 5-1.2',
  save: 'M5 3h12l4 4v14H3V3h2Z M7 3v6h10V3 M7 21v-8h10v8',
  undo: 'M9 4 3 10l6 6 M3 10h11a7 7 0 0 1 7 7v3',
  redo: 'm15 4 6 6-6 6 M21 10H10a7 7 0 0 0-7 7v3',
  play: 'm8 4 12 8-12 8V4Z', pause: 'M7 4v16 M17 4v16',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4 M12 18h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  chevron: 'm7 10 5 5 5-5', close: 'm6 6 12 12 M6 18 18 6',
  folder: 'M3 7V4h6l2 3h10v13H3V7Z',
  copy: 'M8 8h13v13H8V8Z M16 8V3H3v13h5',
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
