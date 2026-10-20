/**
 * The AL AI mark.
 *
 * A shield whose face is the bot, drawn once and used everywhere the platform
 * identifies itself: the sidebar, the mobile drawer, the login screen and the
 * favicon. It is drawn inline rather than loaded as an image so it can take the
 * theme's colours - a raster mark would be one more thing that looks wrong in
 * the light palette - and so it costs no request.
 *
 * The silhouette is the whole design: a shield, an antenna, two eyes. That is
 * what survives being scaled down to 16 pixels, which is where a brand mark
 * usually falls apart.
 */
export function BrandMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="AL AI" fill="none">
      <defs>
        <linearGradient id="al-ai-mark" x1="0" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {/* The shield body: the platform protects a server, and the bot is the
          thing that does it. */}
      <path
        d="M32 12.5 49.5 19v13.4c0 10.9-7.2 20.2-17.5 25.6-10.3-5.4-17.5-14.7-17.5-25.6V19z"
        fill="url(#al-ai-mark)"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* The antenna: the one stroke that says "bot" rather than "security
          badge". */}
      <path d="M32 13.5V9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="32" cy="7" r="2.8" fill="currentColor" />
      {/* The face. */}
      <circle cx="25.2" cy="30.5" r="3.9" fill="currentColor" />
      <circle cx="38.8" cy="30.5" r="3.9" fill="currentColor" />
      <rect x="26.4" y="39.4" width="11.2" height="3.2" rx="1.6" fill="currentColor" opacity="0.75" />
    </svg>
  );
}
