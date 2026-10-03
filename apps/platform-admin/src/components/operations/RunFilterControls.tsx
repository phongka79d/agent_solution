/**
 * Vietnamese-labeled run filters with native date pickers (T8.3).
 *
 * Dates are entered in the operator's local day and serialized server-side (end-of-day `before`
 * bound); the console never asks for a raw ISO string.
 * Explicit label associations keep captions independent of select options; filter actions stay
 * available while results refresh.
 */

'use client';

import { t } from '@agentos/ui-foundation/i18n';
import { useId } from 'react';
import type { RunFilters } from './types';

const STATE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'queued', label: 'Đang chờ' },
  { value: 'running', label: 'Đang chạy' },
  { value: 'waiting', label: 'Chờ xử lý' },
  { value: 'awaiting_human', label: 'Chờ người duyệt' },
  { value: 'completed', label: 'Hoàn tất' },
  { value: 'failed', label: 'Thất bại' },
  { value: 'stopped', label: 'Đã dừng' },
];

const DOMAIN_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Tất cả lĩnh vực' },
  { value: 'sales', label: 'Bán hàng' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'support', label: 'CSKH' },
  { value: 'unknown', label: 'Chưa xác định' },
];

interface RunFilterControlsProps {
  readonly filters: RunFilters;
  readonly isLoading: boolean;
  readonly onChange: (filters: RunFilters) => void;
  readonly onApply: () => void;
  readonly onReset: () => void;
}

export function RunFilterControls({ filters, isLoading, onChange, onApply, onReset }: RunFilterControlsProps) {
  const filterId = useId();
  const update = (patch: Partial<RunFilters>) => onChange({ ...filters, ...patch });
  return (
    <form
      className="platform-card grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5"
      onSubmit={(event) => { event.preventDefault(); onApply(); }}
      aria-label="Bộ lọc lượt chạy"
    >
      <div className="flex flex-col gap-1 text-xs font-medium text-ink sm:col-span-2">
        <label htmlFor={`${filterId}-search`}>Tìm kiếm</label>
        <input
          id={`${filterId}-search`}
          className="ui-input ui-focus-ring"
          type="search"
          value={filters.search}
          placeholder="Mã lượt chạy hoặc mã tương quan"
          onChange={(event) => update({ search: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1 text-xs font-medium text-ink">
        <label htmlFor={`${filterId}-company`}>Công ty</label>
        <input
          id={`${filterId}-company`}
          className="ui-input ui-focus-ring"
          type="text"
          value={filters.company_id}
          placeholder="Mã hoặc tên công ty"
          onChange={(event) => update({ company_id: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1 text-xs font-medium text-ink">
        <label htmlFor={`${filterId}-state`}>Trạng thái</label>
        <select id={`${filterId}-state`} className="ui-select ui-focus-ring" value={filters.state} onChange={(event) => update({ state: event.target.value })}>
          {STATE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1 text-xs font-medium text-ink">
        <label htmlFor={`${filterId}-domain`}>Lĩnh vực</label>
        <select id={`${filterId}-domain`} className="ui-select ui-focus-ring" value={filters.domain} onChange={(event) => update({ domain: event.target.value })}>
          {DOMAIN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1 text-xs font-medium text-ink">
        <label htmlFor={`${filterId}-from`}>Từ ngày</label>
        <input id={`${filterId}-from`} className="ui-input ui-focus-ring" type="date" value={filters.from} onChange={(event) => update({ from: event.target.value })} />
      </div>
      <div className="flex flex-col gap-1 text-xs font-medium text-ink">
        <label htmlFor={`${filterId}-to`}>Đến ngày</label>
        <input id={`${filterId}-to`} className="ui-input ui-focus-ring" type="date" value={filters.to} onChange={(event) => update({ to: event.target.value })} />
      </div>
      <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-5">
        <button type="submit" className="ui-button ui-button--primary ui-button--compact">
          {isLoading ? t('common.loading') : 'Áp dụng bộ lọc'}
        </button>
        <button type="button" className="ui-button ui-button--secondary ui-button--compact" onClick={() => onReset()} data-testid="run-filters-reset">
          Xóa bộ lọc
        </button>
      </div>
    </form>
  );
}
