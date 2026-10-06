import { createHash, createHmac, randomBytes } from "node:crypto";

/** Use only with high-entropy identifiers such as runtime IDs, never payload text. */
export function hashStableRef(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("stable reference must be a non-empty string");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The returned key is process-local and must never be written to plugin storage. */
export function createPayloadFingerprintKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Fingerprint payloads transiently; only the HMAC digest may be retained. */
export function fingerprintPayload(value: unknown, key: Uint8Array): string | undefined {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || value === undefined) return undefined;
  let serialized: string;
  let typeTag: string;
  try {
    typeTag = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (typeof value === "string") serialized = value;
    else {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) return undefined;
      serialized = encoded;
    }
  } catch {
    return undefined;
  }
  try {
    return createHmac("sha256", key).update(typeTag, "utf8").update("\u0000", "utf8").update(serialized, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}
