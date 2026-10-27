import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  decryptBackup,
  encryptBackup,
  generateBackupKeyPair,
  getBackupKeyFingerprint,
  readBackupKeyFingerprint
} from "../src/modules/storage/backup-crypto.js";
import {
  createStoreSnapshot,
  createUpstashPipeline,
  parseStoreSnapshot,
  restoreStoreSnapshot,
  type StoreSnapshot
} from "../src/modules/storage/store-backup.js";

const usage = `Usage (from the repo root):
  pnpm --filter @linkdish/extractor-api backup:store keygen --out-dir ~/linkdish-backup-key
  pnpm --filter @linkdish/extractor-api backup:store create --out backup.ldbak
  pnpm --filter @linkdish/extractor-api backup:store inspect --file backup.ldbak --private-key key.pem
  pnpm --filter @linkdish/extractor-api backup:store restore --file backup.ldbak --private-key key.pem [--only linkdish:user:] [--overwrite] [--confirm]

create reads UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN and LINKDISH_BACKUP_PUBLIC_KEY.
restore writes to the Upstash database in UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
A private key made with a passphrase is read with LINKDISH_BACKUP_KEY_PASSPHRASE.

restore is a dry run without --confirm. Without --overwrite it only fills in keys that are
missing (a synced library only when none of it is there); with it, keys in the backup
replace what is there now. --only narrows it to keys with that prefix, and a synced library
is always restored whole. inspect --out writes the decrypted snapshot as JSON: it holds
account data, so keep it off shared disks.`;

type Args = Record<string, string | string[] | true>;

const flagNames = new Set(["allow-empty", "confirm", "help", "overwrite"]);

const readArgs = (argv: string[]): { args: Args; command: string } => {
  const [command = "help", ...rest] = argv.filter((arg) => arg !== "--");
  const args: Args = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg ?? ""}`);
    }

    const key = arg.slice(2);

    if (flagNames.has(key)) {
      args[key] = true;
      continue;
    }

    const value = rest[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }

    if (key === "only") {
      args.only = [...((args.only as string[] | undefined) ?? []), value];
    } else {
      args[key] = value;
    }

    index += 1;
  }

  return { args, command };
};

const requireString = (args: Args, key: string): string => {
  const value = args[key];

  if (typeof value !== "string") {
    throw new Error(`--${key} is required.\n\n${usage}`);
  }

  return value;
};

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is not set.`);
  }

  return value;
};

const getPipeline = () =>
  createUpstashPipeline(
    requireEnv("UPSTASH_REDIS_REST_URL"),
    requireEnv("UPSTASH_REDIS_REST_TOKEN")
  );

const readSnapshot = (args: Args): StoreSnapshot => {
  const envelope = readFileSync(requireString(args, "file"), "utf8");
  const privateKeyPem = readFileSync(requireString(args, "private-key"), "utf8");

  return parseStoreSnapshot(
    decryptBackup(envelope, privateKeyPem, process.env.LINKDISH_BACKUP_KEY_PASSPHRASE || undefined)
  );
};

const describeCounts = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n") || "  (none)";

const keygen = (args: Args): void => {
  const outDir = requireString(args, "out-dir");
  const privatePath = join(outDir, "linkdish-backup-private.pem");
  const publicPath = join(outDir, "linkdish-backup-public.pem");

  if (existsSync(privatePath)) {
    throw new Error(`${privatePath} already exists; refusing to replace a backup key.`);
  }

  const { privateKeyPem, publicKeyPem } = generateBackupKeyPair(
    process.env.LINKDISH_BACKUP_KEY_PASSPHRASE || undefined
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
  chmodSync(privatePath, 0o600);
  writeFileSync(publicPath, publicKeyPem);

  console.log(`Private key: ${privatePath} (keep it offline; without it no backup can be read)`);
  console.log(`Public key:  ${publicPath} (store it as the LINKDISH_BACKUP_PUBLIC_KEY secret)`);
  console.log(`Fingerprint: ${getBackupKeyFingerprint(publicKeyPem)}`);
};

/*
 * Logs only sizes and the key fingerprint: the workflow log of a public repository is public,
 * so account counts stay inside the encrypted file.
 */
const create = async (args: Args): Promise<void> => {
  const out = requireString(args, "out");
  const publicKeyPem = requireEnv("LINKDISH_BACKUP_PUBLIC_KEY");
  const snapshot = await createStoreSnapshot(getPipeline());

  if (!args["allow-empty"] && !snapshot.families.user) {
    throw new Error(
      "The snapshot has no user records. Check that the Upstash secrets point at production, or pass --allow-empty."
    );
  }

  const unclassified = Object.keys(snapshot.unclassified);

  if (unclassified.length > 0) {
    // Segment names only, never keys.
    console.warn(
      `Keys under these segments match no backup family and were left out: ${unclassified.join(", ")}. ` +
        "Classify them in src/modules/storage/store-key-families.ts."
    );
  }

  if (snapshot.incoherentLibraries) {
    console.warn(
      `${snapshot.incoherentLibraries} synced libraries kept changing while being read and were ` +
        "taken as last read; restoring them may make devices pull them again."
    );
  }

  const envelope = encryptBackup(JSON.stringify(snapshot), publicKeyPem);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, envelope);

  console.log(
    `Backup written to ${out} (${Buffer.byteLength(envelope)} bytes, key ${getBackupKeyFingerprint(publicKeyPem)}).`
  );
};

const inspect = (args: Args): void => {
  const fingerprint = readBackupKeyFingerprint(readFileSync(requireString(args, "file"), "utf8"));
  const snapshot = readSnapshot(args);

  console.log(`Snapshot taken ${snapshot.createdAt} (key ${fingerprint})`);
  console.log(`Entries: ${snapshot.entries.length}`);
  console.log(`Backed up, per family:\n${describeCounts(snapshot.families)}`);
  console.log(`Left out as disposable, per segment:\n${describeCounts(snapshot.skipped)}`);
  console.log(`Left out as unclassified, per segment:\n${describeCounts(snapshot.unclassified)}`);
  console.log(`Libraries taken as last read: ${snapshot.incoherentLibraries ?? 0}`);

  if (typeof args.out === "string") {
    writeFileSync(args.out, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    // The mode only applies to a new file.
    chmodSync(args.out, 0o600);
    console.log(`Decrypted snapshot written to ${args.out}`);
  }
};

const restore = async (args: Args): Promise<void> => {
  const snapshot = readSnapshot(args);
  const apply = args.confirm === true;
  const result = await restoreStoreSnapshot(getPipeline(), snapshot, {
    apply,
    keyPrefixes: (args.only as string[] | undefined) ?? [],
    overwrite: args.overwrite === true
  });

  console.log(`Snapshot taken ${snapshot.createdAt}`);
  console.log(
    [
      `${apply ? "Wrote" : "Would write"} ${result.written} missing keys`,
      `${apply ? "replaced" : "would replace"} ${result.replaced} existing keys`,
      `kept ${result.kept} existing keys`,
      `skipped ${result.expired} expired sessions or invites`,
      `left out ${result.ofDeletedAccounts} keys of accounts deleted since`,
      `and ${result.ofChangedEmails} lookups of email addresses changed since`
    ].join(", ")
  );

  if (!apply) {
    console.log("\nDry run only. Add --confirm to write to Upstash.");
  }
};

const main = async (): Promise<void> => {
  const { args, command } = readArgs(process.argv.slice(2));

  if (args.help || command === "help") {
    console.log(usage);
    return;
  }

  switch (command) {
    case "keygen":
      keygen(args);
      return;
    case "create":
      await create(args);
      return;
    case "inspect":
      inspect(args);
      return;
    case "restore":
      await restore(args);
      return;
    default:
      throw new Error(`Unknown command ${command}.\n\n${usage}`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
