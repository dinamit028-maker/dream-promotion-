/**
 * Loading an account's data onto this device (store.hydrate). Work made on this device before the first
 * sign-in is uploaded once into an empty account — but data of ANOTHER business or user that is still
 * cached here is never uploaded: after switching business it is simply replaced by the new business's data.
 */
export function hydratePlan(
  local: { userId: string | null; businessId: string | null; hasWork: boolean },
  next: { userId: string; businessId: string | null },
) {
  const switched = Boolean(local.businessId && next.businessId && local.businessId !== next.businessId)
    || Boolean(local.userId && local.userId !== next.userId);
  return { switched, mayUploadLocal: !switched && local.hasWork };
}
