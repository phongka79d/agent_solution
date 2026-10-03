import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';

export interface IdChipProps {
  /** Machine identifier shown only inside the chip title, never as the primary label. */
  readonly value: string;
  /** Human label; falls back to a shortened form of `value`. */
  readonly label?: ReactNode;
  readonly copyable?: boolean;
  readonly className?: string;
}

function shorten(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

export function IdChip({ value, label, copyable = false, className }: IdChipProps) {
  return (
    <span className={['ui-id-chip', className].filter(Boolean).join(' ')}>
      <span className="ui-id-chip__label" title={value}>
        {label ?? shorten(value)}
      </span>
      {copyable ? (
        <button
          type="button"
          className="ui-id-chip__copy ui-focus-ring"
          aria-label={`${label ?? shorten(value)}`}
          onClick={() => void navigator.clipboard?.writeText(value)}
        >
          <Copy aria-hidden="true" size={12} />
        </button>
      ) : null}
    </span>
  );
}
