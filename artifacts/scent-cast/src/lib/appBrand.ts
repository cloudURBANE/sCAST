/** Visible wordmark (nav, footer, modals). Override at build time with VITE_PUBLIC_APP_NAME. */
export const APP_BRAND_MARK =
  (import.meta.env.VITE_PUBLIC_APP_NAME as string | undefined)?.trim() || 'SCENTBEAM';

/** Abbreviated wordmark for tight layouts (mobile nav). Override with VITE_PUBLIC_APP_NAME_SHORT. */
export const APP_BRAND_MARK_SHORT =
  (import.meta.env.VITE_PUBLIC_APP_NAME_SHORT as string | undefined)?.trim() || 'SB';
