export function useTranslation() {
  return { t: (key: string, values?: Record<string, unknown>) => {
    const label = key.split(".").at(-1)?.replace(/([A-Z])/g, " $1").replace(/[-_]/g, " ") || key;
    return Object.entries(values || {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), label);
  } };
}
