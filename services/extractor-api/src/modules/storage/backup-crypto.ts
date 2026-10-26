import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/*
 * Backups are encrypted to a public key: the nightly job only ever holds the public half, and
 * the private key stays offline with the owner. Each file gets a fresh AES-256-GCM key, wrapped
 * with RSA-OAEP (SHA-256). Backups land in GitHub Actions artifacts, which anyone signed in to
 * GitHub can download on a public repository, so nothing in them is readable without that key.
 */

export const BACKUP_ENVELOPE_FORMAT = "linkdish-backup-envelope";
export const BACKUP_ENVELOPE_VERSION = 1;

interface BackupEnvelope {
  authTag: string;
  ciphertext: string;
  cipher: "aes-256-gcm";
  compression: "gzip";
  format: typeof BACKUP_ENVELOPE_FORMAT;
  iv: string;
  keyFingerprint: string;
  keyWrap: "rsa-oaep-sha256";
  version: typeof BACKUP_ENVELOPE_VERSION;
  wrappedKey: string;
}

/* First 16 hex characters of the SHA-256 of the public key (SPKI DER), to match key and file. */
export const getBackupKeyFingerprint = (publicKeyPem: string): string =>
  createHash("sha256")
    .update(createPublicKey(publicKeyPem).export({ format: "der", type: "spki" }))
    .digest("hex")
    .slice(0, 16);

export const generateBackupKeyPair = (
  passphrase?: string
): { privateKeyPem: string; publicKeyPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });

  return {
    privateKeyPem: privateKey
      .export({
        format: "pem",
        type: "pkcs8",
        ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {})
      })
      .toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString()
  };
};

export const encryptBackup = (plaintext: string, publicKeyPem: string): string => {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plaintext)), cipher.final()]);
  const envelope: BackupEnvelope = {
    authTag: cipher.getAuthTag().toString("base64"),
    cipher: "aes-256-gcm",
    ciphertext: ciphertext.toString("base64"),
    compression: "gzip",
    format: BACKUP_ENVELOPE_FORMAT,
    iv: iv.toString("base64"),
    keyFingerprint: getBackupKeyFingerprint(publicKeyPem),
    keyWrap: "rsa-oaep-sha256",
    version: BACKUP_ENVELOPE_VERSION,
    wrappedKey: publicEncrypt(
      { key: publicKeyPem, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
      dataKey
    ).toString("base64")
  };

  return JSON.stringify(envelope);
};

export const readBackupKeyFingerprint = (envelopeJson: string): string =>
  (JSON.parse(envelopeJson) as Partial<BackupEnvelope>).keyFingerprint ?? "";

export const decryptBackup = (
  envelopeJson: string,
  privateKeyPem: string,
  passphrase?: string
): string => {
  const envelope = JSON.parse(envelopeJson) as Partial<BackupEnvelope>;

  if (
    envelope.format !== BACKUP_ENVELOPE_FORMAT ||
    envelope.version !== BACKUP_ENVELOPE_VERSION ||
    !envelope.wrappedKey ||
    !envelope.iv ||
    !envelope.authTag ||
    !envelope.ciphertext
  ) {
    throw new Error("Not a LinkDish backup file this tool can read.");
  }

  const privateKey = createPrivateKey({ key: privateKeyPem, passphrase });
  const dataKey = privateDecrypt(
    { key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(envelope.wrappedKey, "base64")
  );
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);

  return gunzipSync(compressed).toString("utf8");
};
