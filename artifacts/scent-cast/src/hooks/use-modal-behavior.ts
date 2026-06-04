import * as React from "react";

type ElementRef = React.RefObject<HTMLElement | null>;

interface UseModalBehaviorOptions {
  isOpen: boolean;
  containerRef: ElementRef;
  initialFocusRef?: ElementRef;
  onDismiss?: () => void;
  closeOnEscape?: boolean;
  lockScroll?: boolean;
  restoreFocus?: boolean;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

const modalStack: string[] = [];
let scrollLockCount = 0;
let lockedScrollX = 0;
let lockedScrollY = 0;
let previousBodyStyles: Partial<
  Pick<CSSStyleDeclaration, "overflow" | "position" | "top" | "left" | "right" | "width">
> = {};

function isVisibleFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isVisibleFocusable,
  );
}

function lockBodyScroll(): () => void {
  if (scrollLockCount === 0) {
    lockedScrollX = window.scrollX || window.pageXOffset || 0;
    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    previousBodyStyles = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
    };

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.style.left = `-${lockedScrollX}px`;
    document.body.style.right = "0";
    document.body.style.width = "100%";
  }

  scrollLockCount += 1;

  return () => {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) {
      document.body.style.overflow = previousBodyStyles.overflow ?? "";
      document.body.style.position = previousBodyStyles.position ?? "";
      document.body.style.top = previousBodyStyles.top ?? "";
      document.body.style.left = previousBodyStyles.left ?? "";
      document.body.style.right = previousBodyStyles.right ?? "";
      document.body.style.width = previousBodyStyles.width ?? "";
      window.scrollTo(lockedScrollX, lockedScrollY);
      previousBodyStyles = {};
      lockedScrollX = 0;
      lockedScrollY = 0;
    }
  };
}

function removeFromStack(id: string) {
  const index = modalStack.lastIndexOf(id);
  if (index >= 0) {
    modalStack.splice(index, 1);
  }
}

export function useModalBehavior({
  isOpen,
  containerRef,
  initialFocusRef,
  onDismiss,
  closeOnEscape = true,
  lockScroll = true,
  restoreFocus = true,
}: UseModalBehaviorOptions) {
  const id = React.useId();
  const onDismissRef = React.useRef(onDismiss);
  const restoreTargetRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  React.useEffect(() => {
    if (!isOpen || typeof document === "undefined" || typeof window === "undefined") return;

    restoreTargetRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.push(id);

    const unlockScroll = lockScroll ? lockBodyScroll() : undefined;
    const focusFrame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;

      const focusTarget = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container;
      if (focusTarget === container && !container.hasAttribute("tabindex")) {
        container.tabIndex = -1;
      }
      focusTarget.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;

      if (event.key === "Escape" && closeOnEscape && onDismissRef.current) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onDismissRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const container = containerRef.current;
      if (!container) return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!(activeElement instanceof Node) || !container.contains(activeElement)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      removeFromStack(id);
      unlockScroll?.();

      const restoreTarget = restoreTargetRef.current;
      if (restoreFocus && restoreTarget?.isConnected) {
        window.requestAnimationFrame(() => {
          restoreTarget.focus({ preventScroll: true });
        });
      }
    };
  }, [
    closeOnEscape,
    containerRef,
    id,
    initialFocusRef,
    isOpen,
    lockScroll,
    restoreFocus,
  ]);
}
