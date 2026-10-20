import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolierte Test-Umgebung: eigene PGlite-DB pro Testlauf, feste Secrets.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socialhub-test-"));
process.env.DATA_DIR = dir;
process.env.DATABASE_URL = "";
process.env.APP_URL = "http://localhost:3000";
process.env.AUTH_PASSWORD = "test-password-123";
process.env.AUTH_SECRET = randomBytes(32).toString("base64url");
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.MCP_API_KEY = "sh_test_key_1234567890";
process.env.META_APP_ID = "123";
process.env.META_APP_SECRET = "secret";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
process.env.TIKTOK_CLIENT_KEY = "tk";
process.env.TIKTOK_CLIENT_SECRET = "tsecret";
process.env.LINKEDIN_CLIENT_ID = "lid";
process.env.LINKEDIN_CLIENT_SECRET = "lsecret";
process.env.X_CLIENT_ID = "xid";
process.env.X_CLIENT_SECRET = "xsecret";
