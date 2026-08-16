/** 基础 UI 组件：卡片、分段控件、开关、按钮、标签。 */
import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`card ${className}`} style={style}>
      {children}
    </section>
  );
}

export function SectionHeader({
  title,
  subtitle,
  aside,
}: {
  title: string;
  subtitle?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div className="section-header-copy">
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {aside ? <div className="section-header-aside">{aside}</div> : null}
    </header>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`segmented-option ${option.value === value ? "is-active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? "is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled = false,
  title,
  className = "",
  active = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "quiet" | "success";
  disabled?: boolean;
  title?: string;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${active ? "is-active" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  onClick,
  selected = false,
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  title?: string;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        className={`chip ${selected ? "is-selected" : ""} ${className}`}
        onClick={onClick}
        aria-pressed={selected}
        title={title}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={`chip ${selected ? "is-selected" : ""} ${className}`} title={title}>
      {children}
    </span>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="empty-hint">{children}</div>;
}
