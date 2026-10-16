"use client";

import type { KeyboardEvent, ReactNode } from "react";

export function Fieldset({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={`card p-4 sm:p-5 ${className}`}>
      <legend className="sr-only">{title}</legend>
      <div className="mb-3">
        <div className="eyebrow">{title}</div>
        {description ? <p className="mt-1 text-xs text-muted">{description}</p> : null}
      </div>
      <div className="grid gap-3.5">{children}</div>
    </fieldset>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = "",
  right,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-paper/85">
          {label}
        </label>
        {right}
      </div>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

export type SelectOption = { id: string; label: string; disabled?: boolean; hint?: string };

export function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  placeholder,
  ariaLabel,
  className = "",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      className={`ctl ${className}`}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.disabled}>
          {o.label}
          {o.hint ? ` (${o.hint})` : ""}
        </option>
      ))}
    </select>
  );
}

export function TextArea({
  id,
  value,
  onChange,
  rows = 3,
  placeholder,
  maxLength,
  disabled,
  className = "",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <textarea
      id={id}
      className={`ctl ${className}`}
      value={value}
      rows={rows}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  maxLength,
  disabled,
  type = "text",
  className = "",
  ariaLabel,
  onBlur,
  onKeyDown,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  type?: string;
  className?: string;
  ariaLabel?: string;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      id={id}
      type={type}
      className={`ctl ${className}`}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`spinner ${className}`} aria-hidden="true" />;
}

export function CharCount({ value, max }: { value: string; max: number }) {
  const n = value.length;
  const warn = n > max * 0.9;
  return (
    <span className={`text-[11px] tabular-nums ${warn ? "text-warn" : "text-faint"}`}>
      {n}/{max}
    </span>
  );
}
