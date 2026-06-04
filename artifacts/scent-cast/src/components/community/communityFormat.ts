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
  const local = author.email.split('@')[0]?.trim();
  return local || 'Community member';
}

export function communitySharePath(author: CommunityAuthor): string {
  return `/share/${encodeURIComponent(author.shareId)}`;
}
