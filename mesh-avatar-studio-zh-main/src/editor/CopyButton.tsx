import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { Icon } from './Icon';

export function CopyButton({ value, label, icon = false }: { value: string; label: string; icon?: boolean }) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<'done' | 'error' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(value); setFeedback('done'); }
    catch { setFeedback('error'); }
    timer.current = setTimeout(() => setFeedback(null), 2000);
  };
  const text = feedback === 'done' ? `✓ ${t.copyDone}` : feedback === 'error' ? t.copyError : label;
  return <button type="button" className={`copy-button${icon && !feedback ? ' icon-button' : ''}`} aria-label={text} title={label} aria-live="polite" onClick={() => { void copy(); }}>
    {icon && !feedback ? <Icon name="copy" /> : text}
  </button>;
}
