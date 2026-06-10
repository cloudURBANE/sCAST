import React from 'react';
import { Grid2X2, Rows3 } from 'lucide-react';
import type { VaultGridMode } from '@/hooks/useVaultGridPreference';

type VaultGridModeToggleProps = {
  mode: VaultGridMode;
  onChange: (mode: VaultGridMode) => void;
  className?: string;
};

export const VaultGridModeToggle: React.FC<VaultGridModeToggleProps> = ({
  mode,
  onChange,
  className = '',
}) => {
  return (
    <div
      className={`scent-vault-grid-toggle ${className}`}
      role="group"
      aria-label="Vault mobile layout"
    >
      <button
        type="button"
        aria-pressed={mode === 'roomy'}
        title="Single column"
        onClick={() => onChange('roomy')}
        className="scent-vault-grid-toggle__button"
      >
        <Rows3 size={16} strokeWidth={1.65} aria-hidden="true" />
        <span className="sr-only">Single column</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === 'compact'}
        title="Compact grid"
        onClick={() => onChange('compact')}
        className="scent-vault-grid-toggle__button"
      >
        <Grid2X2 size={16} strokeWidth={1.65} aria-hidden="true" />
        <span className="sr-only">Compact grid</span>
      </button>
    </div>
  );
};
