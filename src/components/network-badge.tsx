import type { Network } from "@/lib/db/schema";
import { cn } from "./ui";

const styles: Record<Network, { label: string; className: string; short: string }> = {
  instagram: { label: "Instagram", className: "bg-pink-100 text-pink-800", short: "IG" },
  facebook: { label: "Facebook", className: "bg-blue-100 text-blue-800", short: "FB" },
  youtube: { label: "YouTube", className: "bg-red-100 text-red-800", short: "YT" },
  tiktok: { label: "TikTok", className: "bg-zinc-900 text-white", short: "TT" },
  linkedin: { label: "LinkedIn", className: "bg-sky-100 text-sky-900", short: "LI" },
  x: { label: "X", className: "bg-zinc-200 text-zinc-900", short: "X" },
};

export function NetworkBadge({ network, className }: { network: Network; className?: string }) {
  const s = styles[network];
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", s.className, className)}>{s.label}</span>;
}

export function NetworkDot({ network, className }: { network: Network; className?: string }) {
  const s = styles[network];
  return <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold", s.className, className)}>{s.short}</span>;
}

export const networkLabel = (n: Network) => styles[n].label;
