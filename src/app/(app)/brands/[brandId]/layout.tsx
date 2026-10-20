import Link from "next/link";
import { notFound } from "next/navigation";
import { getBrand } from "@/lib/services/brands";

export const dynamic = "force-dynamic";

export default async function BrandLayout({ children, params }: { children: React.ReactNode; params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const brand = await getBrand(brandId);
  if (!brand) notFound();
  const tabs = [
    { href: `/brands/${brand.id}`, label: "Konten & Analytics" },
    { href: `/brands/${brand.id}/publish`, label: "Veröffentlichen" },
    { href: `/brands/${brand.id}/reports`, label: "Reports" },
  ];
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Brand</div>
          <h1 className="text-xl font-semibold">{brand.name}</h1>
        </div>
        <nav className="flex gap-1 text-sm">
          {tabs.map((t) => (
            <Link key={t.href} href={t.href} className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100">
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
