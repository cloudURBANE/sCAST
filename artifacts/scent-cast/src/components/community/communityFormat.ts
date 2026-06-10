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

  // Fallback for members who have not chosen one: use the Google email's
  // local-part as a readable username without exposing the full address.
  const localPart = author.email.trim().split('@')[0]?.trim();
  if (localPart) {
    const withoutPlusTag = localPart.split('+')[0]?.trim() || localPart;
    const cleaned = withoutPlusTag
      .replace(/[._-]+/g, ' ')
      .replace(/[^0-9a-z ]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || withoutPlusTag;
  }

  return 'Community member';
}

export function communitySharePath(author: CommunityAuthor): string {
  return `/share/${encodeURIComponent(author.shareId)}`;
}
