/**
 * A language's flag, drawn inline.
 *
 * Inline SVG rather than an image or an emoji: Windows renders a country-flag
 * emoji as its two-letter code (`IQ`, `GB`), and an image is one more request
 * and one more asset to keep. These are the marks the language list shows beside
 * each option — the Arabic option is Iraq's flag, English is the Union flag, and
 * German is Germany's.
 */
export function Flag({ value, className = "h-4 w-6" }: { value: "ar" | "en" | "de"; className?: string }) {
  if (value === "de") {
    return (
      <svg viewBox="0 0 24 16" className={className} role="presentation" aria-hidden="true">
        <rect width="24" height="16" fill="#000000" />
        <rect y="5.33" width="24" height="5.34" fill="#DD0000" />
        <rect y="10.67" width="24" height="5.33" fill="#FFCE00" />
      </svg>
    );
  }

  if (value === "ar") {
    return (
      <svg viewBox="0 0 24 16" className={className} role="presentation" aria-hidden="true">
        <rect width="24" height="16" fill="#FFFFFF" />
        <rect width="24" height="5.33" fill="#CE1126" />
        <rect y="10.67" width="24" height="5.33" fill="#000000" />
        <text x="12" y="10.4" textAnchor="middle" fontSize="4.6" fill="#007A3D" fontWeight="bold">
          الله أكبر
        </text>
      </svg>
    );
  }

  // English — the Union flag, the one English mark the design uses.
  return (
    <svg viewBox="0 0 24 16" className={className} role="presentation" aria-hidden="true">
      <rect width="24" height="16" fill="#012169" />
      <path d="M0 0 24 16M24 0 0 16" stroke="#FFFFFF" strokeWidth="3.2" />
      <path d="M0 0 24 16M24 0 0 16" stroke="#C8102E" strokeWidth="1.3" />
      <rect x="9.5" width="5" height="16" fill="#FFFFFF" />
      <rect y="5.5" width="24" height="5" fill="#FFFFFF" />
      <rect x="10.5" width="3" height="16" fill="#C8102E" />
      <rect y="6.5" width="24" height="3" fill="#C8102E" />
    </svg>
  );
}
