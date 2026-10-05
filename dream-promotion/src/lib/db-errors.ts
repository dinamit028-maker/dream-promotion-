/** A Postgres unique violation (23505) on this constraint: the row is already there (a retry after a lost answer). */
export function isDuplicateId(e: { code?: string; message?: string; details?: string } | null | undefined, constraint: string): boolean {
  if (!e) return false;
  const text = `${e.message ?? ''} ${e.details ?? ''}`;
  return (e.code === '23505' || /duplicate key/i.test(text)) && text.includes(constraint);
}
