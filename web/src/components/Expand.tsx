/** A small "Show all N / Show fewer" toggle used to keep long lists short. */
export function ShowMore({ total, shown, expanded, onToggle, noun }: { total: number; shown: number; expanded: boolean; onToggle: () => void; noun: string }) {
  if (total <= shown && !expanded) return null;
  return (
    <button type="button" className="show-more" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "Show fewer" : `Show all ${total} ${noun}`}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden className={expanded ? "flip" : ""}><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}
