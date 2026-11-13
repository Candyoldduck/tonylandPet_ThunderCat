import { useI18n } from './i18n';
import { Icon } from './Icon';
export function GuideSteps() {
  const { t } = useI18n();
  return <ol className="guide-steps">{[t.guide1, t.guide2, t.guide3].map((step, i) =>
    <li key={step}><span>{i + 1}</span>{step}</li>)}</ol>;
}
export function FirstGuide({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return <section className="first-guide" data-testid="first-guide" aria-label={t.guideTitle}>
    <h2>{t.guideTitle}</h2><GuideSteps /><button className="primary" onClick={onDismiss}>{t.gotIt}</button>
  </section>;
}
export function Help({ onClose, onGuide }: { onClose: () => void; onGuide: () => void }) {
  const { t } = useI18n();
  return <section className="help-panel panel" role="dialog" aria-label={t.help} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="panel-title"><h2>{t.help}</h2><button autoFocus className="icon-button" aria-label={t.close} onClick={onClose}><Icon name="close" /></button></div>
    <div className="help-body"><GuideSteps /><h3>{t.shortcuts}</h3><dl>
      {[[t.shortcutUndo, '⌘Z / ⇧⌘Z'], [t.shortcutSave, '⌘S'], [t.shortcutPan, t.spaceDrag],
        [t.shortcutZoom, `${t.wheel} · ⌘+/⌘−/⌘0/⌘1`], [t.shortcutVertex, t.vertexKeys]].map(([label, keys]) =>
        <div key={label}><dt>{label}</dt><dd>{keys}</dd></div>)}
    </dl><button onClick={onGuide}>{t.guideAgain}</button></div>
  </section>;
}
