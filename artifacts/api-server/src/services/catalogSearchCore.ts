/**
 * Escapes SQL LIKE / ILIKE special pattern characters (%, _, \)
 * with a backslash to prevent SQL LIKE wildcard injection and
 * syntax errors with trailing backslashes.
 */
export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
