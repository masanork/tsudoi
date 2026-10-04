const IMPORT_PREVIEW_BATCH_SIZE = 100;
const IMPORT_PREVIEW_MAX_BATCHES = 10;

/** Delete at most 1,000 expired CSV import previews without reading their stored PII. */
export async function cleanupExpiredImportPreviews(db: D1Database): Promise<number> {
  let deletedCount = 0;

  for (let batch = 0; batch < IMPORT_PREVIEW_MAX_BATCHES; batch += 1) {
    const result = await db.prepare(`DELETE FROM roster_import_previews
      WHERE id IN (
        SELECT id FROM roster_import_previews
        WHERE expires_at <= CURRENT_TIMESTAMP
        ORDER BY expires_at
        LIMIT ?
      )
      AND expires_at <= CURRENT_TIMESTAMP`).bind(IMPORT_PREVIEW_BATCH_SIZE).run();

    const deleted = result.meta.changes;
    deletedCount += deleted;
    if (deleted < IMPORT_PREVIEW_BATCH_SIZE) break;
  }

  return deletedCount;
}
