import type { Key, ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { EmptyState } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';

export interface DataTableColumn<TRow> {
  readonly key: string;
  readonly header?: ReactNode;
  readonly label?: ReactNode;
  readonly render?: (row: TRow, index: number) => ReactNode;
  /** Right-aligns numeric values while preserving tabular-nums. */
  readonly numeric?: boolean;
}

export interface DataTableProps<TRow> {
  readonly columns: readonly DataTableColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly getRowKey: (row: TRow, index: number) => Key;
  readonly caption: ReactNode;
  readonly empty?: ReactNode;
  readonly loading?: boolean | ReactNode;
  readonly className?: string;
}

export function DataTable<TRow>({
  columns,
  rows,
  getRowKey,
  caption,
  empty,
  loading = false,
  className,
}: DataTableProps<TRow>) {
  const columnCount = Math.max(columns.length, 1);
  const loadingContent = loading === true ? <LoadingState /> : loading;
  const body = loading
    ? (
        <tr>
          <td colSpan={columnCount}>{loadingContent}</td>
        </tr>
      )
    : rows.length === 0
      ? (
          <tr>
            <td colSpan={columnCount}>
              {empty ?? <EmptyState title={t('common.empty')} />}
            </td>
          </tr>
        )
      : rows.map((row, index) => (
          <tr key={getRowKey(row, index)}>
            {columns.map((column) => {
              const value = column.render
                ? column.render(row, index)
                : (row as unknown as Record<string, unknown>)[column.key];
              return (
                <td key={column.key} className={column.numeric ? 'ui-table__numeric' : undefined}>
                  {value as ReactNode}
                </td>
              );
            })}
          </tr>
        ));

  return (
    // A horizontally scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable).
    <div className={['ui-table-wrap', className].filter(Boolean).join(' ')} tabIndex={0}>
      <table className="ui-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? 'ui-table__numeric' : undefined}
              >
                {column.header ?? column.label ?? column.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
