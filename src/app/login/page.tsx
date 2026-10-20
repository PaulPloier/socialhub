import { Button, Card, Input, Label } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold">SocialHub</h1>
        <p className="mb-5 text-sm text-zinc-500">Anmelden mit dem Passwort aus der .env (AUTH_PASSWORD).</p>
        {sp.error ? <p className="mb-4 rounded-md bg-red-50 p-2 text-sm text-red-700">Falsches Passwort.</p> : null}
        <form method="post" action="/api/auth/login" className="space-y-4">
          <input type="hidden" name="next" value={sp.next ?? "/"} />
          <div>
            <Label htmlFor="password">Passwort</Label>
            <Input id="password" name="password" type="password" autoFocus required />
          </div>
          <Button type="submit" className="w-full">
            Anmelden
          </Button>
        </form>
      </Card>
    </main>
  );
}
