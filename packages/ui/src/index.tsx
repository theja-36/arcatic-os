import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90",
  secondary: "bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--border)]",
  ghost: "bg-transparent text-[var(--text)] hover:bg-[var(--surface-2)]",
  danger: "bg-[var(--danger)] text-white hover:opacity-90",
};

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius)] px-4 text-sm font-medium transition",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...p}
    />
  );
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5", className)} {...p} />;
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]",
        "placeholder:text-[var(--text-muted)] focus:outline focus:outline-2 focus:outline-[var(--accent)]",
        className,
      )}
      {...p}
    />
  );
}

const tones = {
  neutral: "bg-[var(--surface-2)] text-[var(--text-muted)]",
  success: "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]",
  warning: "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]",
  danger: "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)]",
  accent: "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-10 text-center">
      <p className="font-medium text-[var(--text)]">{title}</p>
      <p className="max-w-sm text-sm text-[var(--text-muted)]">{body}</p>
      {action}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${v}%` }} />
    </div>
  );
}

export const jobTone = (s: string) =>
  s === "succeeded" ? "success" : s === "failed" ? "danger" : s === "running" ? "accent" : s === "cancelled" || s === "cancelling" ? "warning" : "neutral";
