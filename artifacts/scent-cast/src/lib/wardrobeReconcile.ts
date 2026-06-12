export type WardrobeReconcileItem = {
  id?: string | null;
  _dbId?: string | null;
  imageUrl?: string | null;
  imageHash?: string | null;
};

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function wardrobeIdentityKey(item: WardrobeReconcileItem): string {
  const dbId = cleanString(item._dbId);
  if (dbId) return `db:${dbId}`;
  const id = cleanString(item.id);
  return id ? `id:${id}` : "";
}

function imageUrlWithoutCacheVersion(value: unknown): unknown {
  const raw = cleanString(value);
  if (!raw) return value ?? "";

  const hashIndex = raw.indexOf("#");
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return raw;

  const path = beforeHash.slice(0, queryIndex);
  const params = new URLSearchParams(beforeHash.slice(queryIndex + 1));
  params.delete("v");
  const query = params.toString();

  return `${path}${query ? `?${query}` : ""}${hash}`;
}

function comparableItem<T extends WardrobeReconcileItem>(item: T): T {
  return {
    ...item,
    imageUrl: imageUrlWithoutCacheVersion(item.imageUrl) as string,
  } as T;
}

function sameMeaningfulItem<T extends WardrobeReconcileItem>(
  current: T,
  incoming: T,
): boolean {
  return JSON.stringify(comparableItem(current)) === JSON.stringify(comparableItem(incoming));
}

function shouldKeepCurrentImageUrl(
  current: WardrobeReconcileItem,
  incoming: WardrobeReconcileItem,
): boolean {
  const currentUrl = cleanString(current.imageUrl);
  const incomingUrl = cleanString(incoming.imageUrl);
  if (!currentUrl) return false;
  if (!incomingUrl) return true;
  if (currentUrl === incomingUrl) return true;
  if (imageUrlWithoutCacheVersion(currentUrl) !== imageUrlWithoutCacheVersion(incomingUrl)) {
    return false;
  }

  const currentHash = cleanString(current.imageHash);
  const incomingHash = cleanString(incoming.imageHash);
  return !incomingHash || incomingHash === currentHash;
}

function keepCurrentImageFields<T extends WardrobeReconcileItem>(current: T, incoming: T): T {
  return {
    ...incoming,
    imageUrl: current.imageUrl,
    ...(!cleanString(incoming.imageHash) && cleanString(current.imageHash)
      ? { imageHash: current.imageHash }
      : {}),
  } as T;
}

export function reconcileWardrobeItems<T extends WardrobeReconcileItem>(
  current: T[],
  incoming: T[],
): T[] {
  if (current.length === 0) return incoming;

  const currentByKey = new Map<string, T>();
  for (const item of current) {
    const key = wardrobeIdentityKey(item);
    if (key && !currentByKey.has(key)) currentByKey.set(key, item);
  }

  const reconciled = incoming.map((incomingItem) => {
    const key = wardrobeIdentityKey(incomingItem);
    const currentItem = key ? currentByKey.get(key) : undefined;
    if (!currentItem) return incomingItem;

    const mergedItem = shouldKeepCurrentImageUrl(currentItem, incomingItem)
      ? keepCurrentImageFields(currentItem, incomingItem)
      : incomingItem;

    return sameMeaningfulItem(currentItem, mergedItem) ? currentItem : mergedItem;
  });

  return reconciled.length === current.length &&
    reconciled.every((item, index) => item === current[index])
    ? current
    : reconciled;
}
