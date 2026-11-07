'use client';
import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n/provider';
import { author } from '../config/author';
import { Icon } from './icons';

export function HelpDialog({ kind, onClose }: { kind: 'flow' | 'docs'; onClose: () => void }) {
  const { t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPlaying(!reduced.matches);
    const change = () => {
      if (reduced.matches) setPlaying(false);
    };
    reduced.addEventListener('change', change);
    return () => {
      element?.close();
      reduced.removeEventListener('change', change);
    };
  }, []);
  useEffect(() => {
    if (!playing || kind !== 'flow') return;
    const timer = setInterval(() => setStep((n) => (n + 1) % 6), 4500);
    return () => clearInterval(timer);
  }, [playing, kind]);
  return (
    <dialog ref={dialog} className="help-dialog" aria-labelledby="help-title" onCancel={onClose}>
      <header className="help-heading">
        <div>
          <span className="section-label">SHARED CONTEXT ENGINE</span>
          <h2 id="help-title">{t(kind === 'flow' ? 'helpFlow' : 'helpDocs')}</h2>
        </div>
        <button className="secondary" autoFocus onClick={onClose}>
          {t('helpClose')} <span aria-hidden="true">×</span>
        </button>
      </header>
      <p className="help-intro">{t(kind === 'flow' ? 'flowIntro' : 'docsIntro')}</p>
      {kind === 'flow' ? (
        <>
          <div className="flow-controls">
            <span>{t('helpStep', { step: step + 1 })}</span>
            <button className="secondary" onClick={() => setPlaying(!playing)}>
              <Icon name={playing ? 'pause' : 'play'} />
              {t(playing ? 'helpPause' : 'helpPlay')}
            </button>
            <button
              className="secondary"
              onClick={() => {
                setPlaying(false);
                setStep((step + 1) % 6);
              }}
            >
              {t('helpNext')}
              <Icon name="arrow" />
            </button>
          </div>
          <ol className={`flow-map ${playing ? 'is-playing' : ''}`} aria-label={t('helpFlow')}>
            {['folder', 'shield', 'refresh', 'memory', 'search', 'check'].map((icon, i) => (
              <li key={icon} className={step === i ? 'active' : ''}>
                <button
                  aria-current={step === i ? 'step' : undefined}
                  onClick={() => {
                    setPlaying(false);
                    setStep(i);
                  }}
                >
                  <span className="flow-node">
                    <Icon name={icon} />
                  </span>
                  <span>{t(`step${i + 1}`)}</span>
                </button>
                <span className="flow-connector" aria-hidden="true">
                  <i />
                </span>
              </li>
            ))}
          </ol>
          <section className="flow-detail" aria-labelledby="flow-detail-title">
            <span className="section-label">{t('helpStep', { step: step + 1 })}</span>
            <h3 id="flow-detail-title">{t(`step${step + 1}`)}</h3>
            <p>{t(`detail${step + 1}`)}</p>
          </section>
          <h3>{t('storageTitle')}</h3>
          <div className="storage-grid">
            {['Local', 'Logs', 'Docker', 'Other'].map((key) => (
              <section className="help-card" key={key}>
                <h4>{t(`storage${key}`)}</h4>
                <p>{t(`storage${key}Text`)}</p>
              </section>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="docs-sections">
            {['Start', 'Repo', 'Mcp', 'Recall', 'Care'].map((key) => (
              <section className="help-card" key={key}>
                <h3>{t(`docs${key}`)}</h3>
                <p>{t(`docs${key}Text`)}</p>
                {key === 'Recall' && <blockquote>{t('docsPrompt')}</blockquote>}
              </section>
            ))}
          </div>
          <footer className="help-author">
            <span>
              {t('authorLabel')}: <strong>{author.name}</strong>
            </span>
            {/^https:\/\/github\.com\/[\w-]+\/?$/.test(author.githubUrl) ? (
              <a href={author.githubUrl} target="_blank" rel="noopener noreferrer">
                GitHub <Icon name="link" />
              </a>
            ) : (
              <span>{t('githubPending')}</span>
            )}
          </footer>
        </>
      )}
    </dialog>
  );
}
