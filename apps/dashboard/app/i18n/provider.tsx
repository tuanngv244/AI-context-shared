'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { translate, type Language } from './messages';
const LanguageContext = createContext<{
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
} | null>(null);
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en');
  useEffect(() => {
    let saved: Language = 'en';
    try {
      if (localStorage.getItem('sce-language') === 'vi') saved = 'vi';
    } catch {}
    setLanguageState(saved);
    document.documentElement.lang = saved;
  }, []);
  function setLanguage(value: Language) {
    setLanguageState(value);
    document.documentElement.lang = value;
    try {
      localStorage.setItem('sce-language', value);
    } catch {}
  }
  return (
    <LanguageContext.Provider
      value={{
        language,
        locale: language === 'vi' ? 'vi-VN' : 'en-US',
        setLanguage,
        t: (key, values) => translate(language, key, values),
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}
export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('LanguageProvider is required');
  return value;
}
export function LanguageSwitch() {
  const { language, setLanguage } = useLanguage();
  return (
    <div
      className="language-switch"
      role="group"
      aria-label={language === 'en' ? 'Language' : 'Ngôn ngữ'}
    >
      {(['en', 'vi'] as const).map((value) => (
        <button
          type="button"
          key={value}
          lang={value}
          aria-label={value === 'en' ? 'English' : 'Tiếng Việt'}
          aria-pressed={language === value}
          onClick={() => setLanguage(value)}
        >
          {value.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
