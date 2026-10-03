import { LoadingState, Skeleton } from '@agentos/ui-foundation/react';

/** Route-level loading boundary: skeleton blocks that match the console content frame. */
export default function AppLoading() {
  return (
    <div className="ui-page-state" aria-busy="true">
      <LoadingState />
      <div className="ui-page-state__skeleton">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </div>
    </div>
  );
}
