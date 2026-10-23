import type { ChangeEvent } from "react";

interface ModelSelectorOption {
  id: string;
  display_name?: string;
}

interface ModelSelectorProps {
  models?: ModelSelectorOption[];
  selectedModelId?: string;
  onSelect?: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "compact" | "default" | string;
}

/** Canvas-local model dropdown; does not depend on the host chat UI. */
export function ModelSelector({
  models = [],
  selectedModelId = "",
  onSelect,
  disabled = false,
  loading = false,
  variant = "default",
}: ModelSelectorProps) {
  const compact = variant === "compact";
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => onSelect?.(event.currentTarget.value);
  const placeholder = loading ? "Loading models…" : models.length ? "Choose model" : "No models";

  return (
    <select
      aria-label="Canvas agent model"
      value={selectedModelId}
      onChange={handleChange}
      disabled={disabled || loading || models.length === 0}
      className={`max-w-[180px] rounded-md border border-[var(--border)] bg-[var(--main-bg)] text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 ${compact ? "h-7 px-1.5 text-[10px]" : "h-9 px-2 text-xs"}`}
      title={models.find((model) => model.id === selectedModelId)?.display_name || "Select a model"}
    >
      {!selectedModelId && <option value="" disabled>{placeholder}</option>}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.display_name || model.id}
        </option>
      ))}
    </select>
  );
}
