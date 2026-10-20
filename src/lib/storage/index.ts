import "server-only";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { env } from "../env";

/**
 * Medien-Ablage. Lokal (DATA_DIR/media, ausgeliefert über /api/media/:id) oder S3.
 * Plattformen wie Instagram/Facebook ziehen Videos per öffentlicher URL, deshalb
 * muss APP_URL (lokal) bzw. S3_PUBLIC_BASE_URL (S3) von außen erreichbar sein.
 */
export interface StoredObject {
  storageKey: string;
  sizeBytes: number;
}

export interface Storage {
  put(key: string, source: Readable | Buffer, contentType: string): Promise<StoredObject>;
  /** Lokaler Dateipfad für Chunk-Uploads (bei S3 wird temporär heruntergeladen). */
  localPath(key: string): Promise<string>;
  publicUrl(key: string, mediaId: string): string;
  delete(key: string): Promise<void>;
}

class LocalStorage implements Storage {
  private root() {
    const dir = path.resolve(env().DATA_DIR, "media");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  async put(key: string, source: Readable | Buffer): Promise<StoredObject> {
    const file = path.join(this.root(), key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (Buffer.isBuffer(source)) {
      fs.writeFileSync(file, source);
    } else {
      await pipeline(source, fs.createWriteStream(file));
    }
    return { storageKey: key, sizeBytes: fs.statSync(file).size };
  }
  async localPath(key: string): Promise<string> {
    return path.join(this.root(), key);
  }
  publicUrl(_key: string, mediaId: string): string {
    return `${env().APP_URL}/api/media/${mediaId}`;
  }
  async delete(key: string): Promise<void> {
    const file = path.join(this.root(), key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

class S3Storage implements Storage {
  private async client() {
    const e = env();
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: e.S3_REGION ?? "auto",
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: !!e.S3_ENDPOINT,
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, source: Readable | Buffer, contentType: string): Promise<StoredObject> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const body = Buffer.isBuffer(source) ? source : await streamToBuffer(source);
    const c = await this.client();
    await c.send(new PutObjectCommand({ Bucket: env().S3_BUCKET!, Key: key, Body: body, ContentType: contentType }));
    return { storageKey: key, sizeBytes: body.length };
  }
  async localPath(key: string): Promise<string> {
    const tmp = path.resolve(env().DATA_DIR, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, key.replace(/\//g, "_"));
    if (fs.existsSync(file)) return file;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    const res = await c.send(new GetObjectCommand({ Bucket: env().S3_BUCKET!, Key: key }));
    const stream = res.Body as unknown as Readable;
    await pipeline(stream, fs.createWriteStream(file));
    return file;
  }
  publicUrl(key: string, mediaId: string): string {
    const e = env();
    if (e.S3_PUBLIC_BASE_URL) return `${e.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
    return `${e.APP_URL}/api/media/${mediaId}`;
  }
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    await c.send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET!, Key: key }));
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (instance) return instance;
  instance = env().MEDIA_STORAGE === "s3" ? new S3Storage() : new LocalStorage();
  return instance;
}

export function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";
}
