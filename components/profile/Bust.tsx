// The grey person placeholder for a portrait or photo with no image, ported from the mockups (`P.bust`:
// a head and shoulders cropped by the bottom edge). Decorative.
export function Bust({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flex: 'none', display: 'block' }}
    >
      <circle cx="12" cy="10" r="5" />
      <path d="M2 26a10 9 0 0 1 20 0" />
    </svg>
  );
}
