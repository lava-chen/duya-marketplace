import { en, zh } from '../translations';

function translate(key: string, values?: Record<string, unknown>): string {
  const language = document.documentElement.lang || navigator.language;
  const labels = language.toLowerCase().startsWith('zh') ? zh : en;
  const text = labels[key] ?? en[key] ?? key.split('.').at(-1) ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    values && Object.hasOwn(values, name) ? String(values[name]) : match);
}

const translation = { t: translate };
export function useTranslation() {
  return translation;
}
