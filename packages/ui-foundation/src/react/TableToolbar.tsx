import type { ReactNode } from 'react';

export interface TableToolbarProps {
  readonly children?: ReactNode;
  readonly search?: ReactNode;
  readonly filters?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function TableToolbar({ children, search, filters, actions, className }: TableToolbarProps) {
  return (
    <div className={['ui-table-toolbar', className].filter(Boolean).join(' ')} role="toolbar">
      {children}
      {search ? <div className="ui-table-toolbar__search">{search}</div> : null}
      {filters ? <div className="ui-table-toolbar__filters">{filters}</div> : null}
      {actions ? <div className="ui-table-toolbar__actions">{actions}</div> : null}
    </div>
  );
}
