/**
 * Encryption of platform tokens at rest (AES-256-GCM). The key is derived with HKDF from TOKEN_ENCRYPTION_KEY, or from
 * AUTH_SECRET when that is not set. Changing the secret makes stored tokens unreadable: the accounts then show
 * "needs reconnect" and are connected again with one click.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(): Buffer {
  const secret = (process.env.TOKEN_ENCRYPTION_KEY ?? process.env.AUTH_SECRET ?? "").trim();
  if (secret.length < 16) throw new Error("Set AUTH_SECRET (or TOKEN_ENCRYPTION_KEY) to store platform tokens.");
  return Buffer.from(hkdfSync("sha256", secret, "content-studio-platform-tokens", "aes-256-gcm", 32));
}

/** "v1.<iv>.<tag>.<ciphertext>", all base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

/** Throws when the blob is malformed or the key changed. */
export function decryptSecret(blob: string): string {
  const [version, iv, tag, data] = blob.split(".");
  if (version !== VERSION || !iv || !tag || !data) throw new Error("Stored token has an unknown format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
