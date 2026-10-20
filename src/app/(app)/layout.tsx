import Link from "next/link";
import { listBrands } from "@/lib/services/brands";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const brands = await listBrands();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="text-base font-semibold tracking-tight">
            SocialHub
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {brands.slice(0, 6).map((b) => (
              <Link key={b.id} href={`/brands/${b.id}`} className="rounded-md px-2.5 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
                {b.name}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/settings" className="rounded-md px-2.5 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
              Einstellungen & MCP
            </Link>
            <form method="post" action="/api/auth/logout">
              <button className="rounded-md px-2.5 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">Abmelden</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
