import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Brand } from "../db/schema";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "brand"
  );
}

export async function listBrands(): Promise<Brand[]> {
  const db = await getDb();
  return db.query.brands.findMany({ orderBy: (t, { asc }) => asc(t.name) });
}

export async function getBrand(id: string): Promise<Brand | undefined> {
  const db = await getDb();
  return db.query.brands.findFirst({ where: eq(schema.brands.id, id) });
}

export async function findBrand(idOrSlugOrName: string): Promise<Brand | undefined> {
  const db = await getDb();
  const all = await db.query.brands.findMany();
  const needle = idOrSlugOrName.trim().toLowerCase();
  return all.find((b) => b.id === idOrSlugOrName) ?? all.find((b) => b.slug === needle) ?? all.find((b) => b.name.toLowerCase() === needle);
}

export async function createBrand(name: string, timezone = "Europe/Vienna"): Promise<Brand> {
  const db = await getDb();
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await db.query.brands.findFirst({ where: eq(schema.brands.slug, slug) }); i++) slug = `${base}-${i}`;
  const [row] = await db.insert(schema.brands).values({ id: crypto.randomUUID(), name: name.trim(), slug, timezone }).returning();
  return row;
}

export async function deleteBrand(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.brands).where(eq(schema.brands.id, id));
}
