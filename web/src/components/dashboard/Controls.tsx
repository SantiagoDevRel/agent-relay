import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`action-button ${className}`} {...props}>{children}</button>;
}
export function Segmented<T extends string | number>({ label, options, value, onChange, disabled }: {
  label: string; options: { value: T; label: ReactNode }[]; value: T; onChange: (value: T) => void; disabled?: boolean;
}) {
  return <div className="segmented" role="group" aria-label={label}>{options.map(option =>
    <Button key={option.value} disabled={disabled} aria-pressed={option.value === value} className={option.value === value ? 'selected' : ''} onClick={() => onChange(option.value)}>{option.label}</Button>
  )}</div>;
}
