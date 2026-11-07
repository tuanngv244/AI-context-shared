'use client';
import { useLanguage } from '../i18n/provider';
import { useEffect, useState } from 'react';
import { Icon } from './icons';
type Theme = 'light' | 'dark' | 'system';
export function ThemeToggle() {
  const { t, locale } = useLanguage();
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sce-theme');
      setTheme(saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system');
    } catch {
      setTheme('system');
    }
  }, []);
  useEffect(() => {
    if (!theme) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  function select(value: Theme) {
    setTheme(value);
    try {
      localStorage.setItem('sce-theme', value);
    } catch {}
    document.documentElement.dataset.theme =
      value === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : value;
  }
  return (
    <div className="theme-toggle" role="group" aria-label={t('Giao diện')}>
      {(
        [
          ['light', 'sun', t('Sáng')],
          ['dark', 'moon', t('Tối')],
          ['system', 'monitor', t('Hệ thống')],
        ] as const
      ).map(([value, icon, label]) => (
        <button
          key={value}
          type="button"
          aria-label={`${t('Giao diện')} ${label.toLocaleLowerCase(locale)}`}
          aria-pressed={theme === value}
          title={label}
          onClick={() => select(value)}
        >
          <Icon name={icon} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
