/** Visible wordmark (nav, footer, modals). Override at build time with VITE_PUBLIC_APP_NAME. */
export const APP_BRAND_MARK =
  (import.meta.env.VITE_PUBLIC_APP_NAME as string | undefined)?.trim() || 'SCENTBEAM';
