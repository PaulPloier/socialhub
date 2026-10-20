import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(...inputs));
}

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600";
const variants = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700",
  secondary: "bg-white text-zinc-900 border border-zinc-300 hover:bg-zinc-50",
  danger: "bg-red-600 text-white hover:bg-red-700",
  ghost: "text-zinc-700 hover:bg-zinc-100",
};
const sizes = { sm: "h-8 px-3", md: "h-10 px-4", lg: "h-11 px-6 text-base" };

type ButtonProps = ComponentProps<"button"> & { variant?: keyof typeof variants; size?: keyof typeof sizes };
export function Button({ className, variant = "primary", size = "md", ...props }: ButtonProps) {
  return <button className={cn(buttonBase, variants[variant], sizes[size], className)} {...props} />;
}

type LinkButtonProps = ComponentProps<typeof Link> & { variant?: keyof typeof variants; size?: keyof typeof sizes };
export function LinkButton({ className, variant = "primary", size = "md", ...props }: LinkButtonProps) {
  return <Link className={cn(buttonBase, variants[variant], sizes[size], className)} {...props} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-zinc-200 bg-white p-5 shadow-sm", className)}>{children}</div>;
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-base font-semibold text-zinc-900 mb-3", className)}>{children}</h2>;
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn("h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("block text-sm font-medium text-zinc-700 mb-1", className)} {...props} />;
}

const badgeColors: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  red: "bg-red-50 text-red-700 border-red-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  zinc: "bg-zinc-100 text-zinc-700 border-zinc-200",
  blue: "bg-sky-50 text-sky-700 border-sky-200",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
};
export function Badge({ color = "zinc", children, className }: { color?: keyof typeof badgeColors; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", badgeColors[color], className)}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function formatNumber(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  return v.toLocaleString("de-AT", { maximumFractionDigits: Number.isInteger(v) ? 0 : digits || 1 });
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "–";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("de-AT", { dateStyle: "medium", timeStyle: "short" });
}

export const statusColor: Record<string, keyof typeof badgeColors> = {
  active: "green",
  reauth_required: "red",
  error: "amber",
  disconnected: "zinc",
  scheduled: "blue",
  publishing: "amber",
  processing: "amber",
  pending: "zinc",
  published: "green",
  partial: "amber",
  failed: "red",
  cancelled: "zinc",
  draft: "zinc",
  queued: "blue",
  running: "amber",
  done: "green",
};

export const statusLabel: Record<string, string> = {
  active: "aktiv",
  reauth_required: "neu verbinden",
  error: "Fehler",
  disconnected: "getrennt",
  scheduled: "geplant",
  publishing: "wird veröffentlicht",
  processing: "wird verarbeitet",
  pending: "wartet",
  published: "veröffentlicht",
  partial: "teilweise",
  failed: "fehlgeschlagen",
  cancelled: "storniert",
  draft: "Entwurf",
  queued: "wartet",
  running: "läuft",
  done: "fertig",
};
