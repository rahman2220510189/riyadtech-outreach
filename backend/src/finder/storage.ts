import type { Db } from "../db/client.js";

/** Used until there are enough places to measure (row + indexes, measured locally). */
export const DEFAULT_BYTES_PER_PLACE = 2048;

export interface StorageCheck {
  ok: boolean;
  databaseMb: number;
  bytesPerPlace: number;
  addedMb: number;
  projectedMb: number;
  limitMb: number;
}

/**
 * Estimates the database size after adding `newPlaces` rows, from the current bytes per place.
 * Neon's free plan has 1 GB; the default limit (Settings > storage) is 900 MB.
 */
export async function checkStorage(db: Db, newPlaces: number, limitMb: number): Promise<StorageCheck> {
  const [row] = await db.$queryRaw<{ db_bytes: bigint; places_bytes: bigint; places: bigint }[]>`
    SELECT pg_database_size(current_database()) AS db_bytes,
           pg_total_relation_size('places') AS places_bytes,
           (SELECT count(*) FROM places) AS places`;
  const count = Number(row?.places ?? 0);
  const bytesPerPlace = count >= 200 ? Math.ceil(Number(row?.places_bytes ?? 0) / count) : DEFAULT_BYTES_PER_PLACE;
  const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
  const dbBytes = Number(row?.db_bytes ?? 0);
  const added = newPlaces * bytesPerPlace;
  return {
    ok: dbBytes + added <= limitMb * 1024 * 1024,
    databaseMb: mb(dbBytes),
    bytesPerPlace,
    addedMb: mb(added),
    projectedMb: mb(dbBytes + added),
    limitMb,
  };
}
