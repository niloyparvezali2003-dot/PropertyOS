/**
 * Short-lived in-memory cache for read-only list screens.
 *
 * This cache is deliberately separate from payment/ledger write transactions.
 * Financial writes must continue to validate against Firestore inside their
 * existing transactions; this helper is only for displaying list data.
 */
const DEFAULT_LIST_CACHE_TTL_MS = 12_000

type CacheEntry<T> = {
  value?: T[]
  expiresAt: number
  pending?: Promise<T[]>
}

const entries = new Map<string, CacheEntry<unknown>>()
const ownerEpochs = new Map<string, number>()

function cacheKey(ownerUid: string, resource: string): string {
  return `${ownerUid}\u0000${resource}`
}

function currentEpoch(ownerUid: string): number {
  return ownerEpochs.get(ownerUid) ?? 0
}

/** Return a cached list when it is still fresh; otherwise load it once. */
export async function getCachedList<T>(
  ownerUid: string,
  resource: string,
  loader: () => Promise<T[]>,
  ttlMs = DEFAULT_LIST_CACHE_TTL_MS,
): Promise<T[]> {
  if (!ownerUid.trim()) return loader()

  const key = cacheKey(ownerUid, resource)
  const existing = entries.get(key) as CacheEntry<T> | undefined

  if (existing?.value && existing.expiresAt > Date.now()) {
    // Return a new array so a page cannot reorder the cached array in place.
    return existing.value.slice()
  }

  if (existing?.pending) {
    return (await existing.pending).slice()
  }

  const requestEpoch = currentEpoch(ownerUid)
  const pending = loader()
  entries.set(key, { expiresAt: 0, pending })

  try {
    const value = await pending

    // A write may have invalidated the cache while this request was running.
    // Never let an older read repopulate a cache after that invalidation.
    if (currentEpoch(ownerUid) === requestEpoch) {
      entries.set(key, {
        value: value.slice(),
        expiresAt: Date.now() + Math.max(0, ttlMs),
      })
    }

    return value.slice()
  } catch (error: unknown) {
    if (currentEpoch(ownerUid) === requestEpoch) entries.delete(key)
    throw error
  }
}

/** Invalidate every cached list belonging to one owner after a successful write. */
export function invalidateOwnerDataCache(ownerUid: string): void {
  if (!ownerUid) return

  ownerEpochs.set(ownerUid, currentEpoch(ownerUid) + 1)
  const prefix = `${ownerUid}\u0000`

  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}

/** Clear in-memory data when the authenticated session ends. */
export function clearAllCachedLists(): void {
  const affectedOwners = new Set(ownerEpochs.keys())

  for (const key of entries.keys()) {
    const separator = key.indexOf('\u0000')
    if (separator > 0) affectedOwners.add(key.slice(0, separator))
  }

  entries.clear()

  for (const ownerUid of affectedOwners) {
    ownerEpochs.set(ownerUid, currentEpoch(ownerUid) + 1)
  }
}
