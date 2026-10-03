import './Skeleton.css';

/** Placeholder post cards while a feed's first page loads — the page keeps its shape instead of
 *  sitting empty above a line of "Loading…" text. Hidden from screen readers; the status line
 *  beside it says what's happening. */
export function PostSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="nu-skeleton-list" aria-hidden="true" data-nu-role="post-skeletons">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="nu-skeleton-post">
          <span className="nu-skeleton nu-skeleton--avatar" />
          <div className="nu-skeleton-post__body">
            <span className="nu-skeleton nu-skeleton--line" style={{ width: '32%' }} />
            <span className="nu-skeleton nu-skeleton--line" style={{ width: i % 2 ? '70%' : '88%' }} />
            {i === 0 && <span className="nu-skeleton nu-skeleton--media" />}
            {i !== 0 && <span className="nu-skeleton nu-skeleton--line" style={{ width: '54%' }} />}
          </div>
        </div>
      ))}
    </div>
  );
}
