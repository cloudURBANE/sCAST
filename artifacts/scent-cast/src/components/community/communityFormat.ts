import type { CommunityAuthor } from '@/components/community/communityPosts';

export function formatCommunityTime(value: string): string {
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return '';

  const diffSeconds = Math.round((time - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 45) return 'just now';

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, seconds] of units) {
    if (absSeconds >= seconds) {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }

  return formatter.format(diffSeconds, 'second');
}

export function displayCommunityAuthor(author: CommunityAuthor): string {
  // A username the member set in profile settings is the public name.
  const username = author.username?.trim();
  if (username) return username;

  // Fallback for members who haven't chosen one. Privacy: never render the email
  // (or its local-part) as a public name — that would leak PII into a public
  // feed. Derive a stable, non-identifying alias from the account id instead.
  const token = author.id.replace(/[^0-9a-z]/gi, '').slice(0, 6).toUpperCase();
  return token ? `Member ${token}` : 'Community member';
}

export function communitySharePath(author: CommunityAuthor): string {
  return `/share/${encodeURIComponent(author.shareId)}`;
}
