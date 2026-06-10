import React from 'react';

export type VaultGridMode = 'roomy' | 'compact';

const STORAGE_KEY = 'scentbeam:vault-grid-mode';

function isVaultGridMode(value: unknown): value is VaultGridMode {
  return value === 'roomy' || value === 'compact';
}

function readStoredMode(): VaultGridMode {
  if (typeof window === 'undefined') return 'roomy';

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isVaultGridMode(stored) ? stored : 'roomy';
  } catch {
    return 'roomy';
  }
}

export function useVaultGridPreference() {
  const [gridMode, setGridModeState] = React.useState<VaultGridMode>(readStoredMode);

  const setGridMode = React.useCallback((nextMode: VaultGridMode) => {
    setGridModeState(nextMode);

    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(STORAGE_KEY, nextMode);
    } catch {
      // Private browsing or locked-down storage should not block the layout toggle.
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !isVaultGridMode(event.newValue)) return;
      setGridModeState(event.newValue);
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return {
    gridMode,
    setGridMode,
    isCompactGrid: gridMode === 'compact',
  };
}
