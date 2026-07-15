/** Canonical media contract for deterministic ustar product exports. */
export const EXPORT_ARCHIVE_MEDIA_TYPE = "application/x-tar" as const;

/** Canonical object/download suffix paired with {@link EXPORT_ARCHIVE_MEDIA_TYPE}. */
export const EXPORT_ARCHIVE_FILE_EXTENSION = ".tar" as const;
