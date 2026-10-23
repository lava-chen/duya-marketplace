import React, { useEffect, useState } from "react";
export function InputDialog({ isOpen, title, placeholder, secondaryPlaceholder, defaultValue = "", onConfirm, onCancel }: { isOpen: boolean; title: string; placeholder?: string; secondaryPlaceholder?: string; defaultValue?: string; onConfirm: (value: string, secondaryValue?: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(defaultValue);
  const [secondaryValue, setSecondaryValue] = useState("");
  useEffect(() => { if (isOpen) setValue(defaultValue); }, [isOpen, defaultValue]);
  useEffect(() => { if (isOpen) setSecondaryValue(""); }, [isOpen]);
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><form className="w-[min(26rem,calc(100vw-2rem))] rounded-xl border bg-white p-4 shadow-xl" onSubmit={(event) => { event.preventDefault(); onConfirm(value, secondaryValue); }}><h2 className="mb-3 font-semibold">{title}</h2><input autoFocus className="w-full rounded-md border px-3 py-2" value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />{secondaryPlaceholder && <label className="mt-3 grid gap-1 text-xs text-gray-600">Optional local project folder path<input className="rounded-md border px-3 py-2 text-sm text-gray-900" value={secondaryValue} placeholder={secondaryPlaceholder} onChange={(event) => setSecondaryValue(event.target.value)} /></label>}<div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onCancel}>Cancel</button><button className="rounded-md bg-indigo-600 px-3 py-1.5 text-white">Save</button></div></form></div>;
}
