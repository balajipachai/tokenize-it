/**
 * The tokenize-it mark: four vesting tranches, three vested (solid green) and one still
 * locked (outlined blue). Inline SVG, so it is crisp at any size and costs no request.
 *
 * `id` namespaces the gradient definitions. Two marks on one page sharing gradient ids
 * would be invalid SVG, and the second would quietly borrow the first one's gradients.
 */
export function Mark({ size = 24, id = "mark" }: { size?: number; id?: string }) {
  const bg = `${id}-bg`;
  const vested = `${id}-vested`;
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1e293b" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
        <linearGradient id={vested} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#059669" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${bg})`} />
      <rect x="116" y="296" width="52" height="90" rx="12" fill={`url(#${vested})`} />
      <rect x="192" y="236" width="52" height="150" rx="12" fill={`url(#${vested})`} />
      <rect x="268" y="176" width="52" height="210" rx="12" fill={`url(#${vested})`} />
      <rect x="349" y="121" width="42" height="260" rx="9" fill="none" stroke="#3b82f6" strokeWidth="10" />
    </svg>
  );
}
