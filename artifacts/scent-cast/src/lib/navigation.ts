const APP_NAVIGATION_EVENT = 'scent:navigation';

type NavigationListener = () => void;

export function navigateTo(path: string): void {
  const nextUrl = new URL(path, window.location.origin);
  const currentUrl = new URL(window.location.href);

  if (
    nextUrl.pathname === currentUrl.pathname &&
    nextUrl.search === currentUrl.search &&
    nextUrl.hash === currentUrl.hash
  ) {
    return;
  }

  window.history.pushState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
}

export function subscribeToNavigation(listener: NavigationListener): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(APP_NAVIGATION_EVENT, listener);

  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(APP_NAVIGATION_EVENT, listener);
  };
}
