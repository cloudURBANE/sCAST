export type ShareIdentityUser = {
  id: string;
  email: string;
};

export function shareHandleFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const normalized = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "user";
}

export function cleanShareRef(userRef: string): string {
  return userRef.trim().toLowerCase().replace(/^@+/, "");
}

export function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function resolveShareUserFromList<T extends ShareIdentityUser>(
  userRef: string,
  users: T[],
): T | null {
  if (isUuidish(userRef)) {
    return users.find((user) => user.id.toLowerCase() === userRef.toLowerCase()) ?? null;
  }

  const cleanRef = cleanShareRef(userRef);
  if (!cleanRef) return null;

  const matches = users.filter((user) => shareHandleFromEmail(user.email) === cleanRef);
  return matches.length === 1 ? matches[0] : null;
}

export function shareIdForUser<T extends ShareIdentityUser>(user: T, users: T[]): string {
  const handle = shareHandleFromEmail(user.email);
  const duplicateHandle = users.some(
    (candidate) => candidate.id !== user.id && shareHandleFromEmail(candidate.email) === handle,
  );
  return duplicateHandle ? user.id : `@${handle}`;
}
