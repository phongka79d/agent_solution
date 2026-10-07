'use client';

import { Search } from 'lucide-react';
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { t } from '../i18n/index.js';

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { className, label, placeholder, ...props },
  ref,
) {
  const accessibleLabel = label ?? t('common.search');
  return (
    <label className={['ui-search-input', className].filter(Boolean).join(' ')}>
      <span className="ui-search-input__icon" aria-hidden="true">
        <Search size={16} />
      </span>
      <span className="sr-only">{accessibleLabel}</span>
      <input
        {...props}
        ref={ref}
        type="search"
        className="ui-input ui-focus-ring ui-search-input__control"
        placeholder={placeholder ?? accessibleLabel}
        aria-label={props['aria-label'] ?? accessibleLabel}
      />
    </label>
  );
});
