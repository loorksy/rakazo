import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface ExpectedMigration {
  name: string;
  checksum: string;
}
export interface SchemaReadiness {
  healthy: boolean;
  /** Fingerprint of the migrations this build ships; identical builds share it. */
  expected: string;
  missing: string[];
  changed: string[];
  unexpected: string[];
  unfinished: string[];
}
interface MigrationRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}
interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

const defaultDirectory = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const manifests = new Map<string, Promise<ExpectedMigration[]>>();

/** The migrations shipped with this exact build, with Prisma's raw-file SHA-256 checksums. */
export function expectedMigrations(directory = defaultDirectory): Promise<ExpectedMigration[]> {
  let manifest = manifests.get(directory);
  if (!manifest) {
    manifest = (async () => {
      const entries = await readdir(directory, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      return Promise.all(
        names.map(async (name) => ({
          name,
          checksum: createHash("sha256")
            .update(await readFile(`${directory}/${name}/migration.sql`))
            .digest("hex"),
        })),
      );
    })();
    manifests.set(directory, manifest);
    manifest.catch(() => manifests.delete(directory));
  }
  return manifest;
}

export const migrationFingerprint = (migrations: ExpectedMigration[]) =>
  createHash("sha256")
    .update(migrations.map((row) => `${row.name}:${row.checksum}`).join("\n"))
    .digest("hex");

/**
 * Compare the deployed database with this build. A database behind the build, ahead of it,
 * edited after application, or mid-migration is never ready for financial admission.
 */
export async function schemaReadiness(
  client: RawQueryClient,
  expected?: ExpectedMigration[],
): Promise<SchemaReadiness> {
  const manifest = expected ?? (await expectedMigrations());
  const rows = await client.$queryRaw<MigrationRow[]>`
    SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations`;
  const applied = new Map<string, MigrationRow>();
  const unfinished: string[] = [];
  for (const row of rows) {
    if (row.rolled_back_at) continue;
    if (!row.finished_at) unfinished.push(row.migration_name);
    else applied.set(row.migration_name, row);
  }
  const known = new Set(manifest.map((row) => row.name));
  const missing = manifest.filter((row) => !applied.has(row.name)).map((row) => row.name);
  const changed = manifest
    .filter((row) => {
      const current = applied.get(row.name);
      return current !== undefined && current.checksum !== row.checksum;
    })
    .map((row) => row.name);
  const unexpected = [...applied.keys()].filter((name) => !known.has(name)).sort();
  return {
    healthy:
      manifest.length > 0 &&
      !missing.length &&
      !changed.length &&
      !unexpected.length &&
      !unfinished.length,
    expected: migrationFingerprint(manifest),
    missing,
    changed,
    unexpected,
    unfinished: unfinished.sort(),
  };
}
