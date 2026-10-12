// Same radar geometry as the app icon, tinted with the dashboard's live palette.
export function Logo({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <radialGradient id="logo-bg" cx="50%" cy="30%" r="80%"><stop offset="0" stopColor="var(--raised)" /><stop offset="1" stopColor="var(--bg)" /></radialGradient>
      <linearGradient id="logo-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--gold)" /><stop offset="1" stopColor="#bc8d32" /></linearGradient>
      <linearGradient id="logo-sweep" x1="32" y1="0" x2="52" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="var(--gold)" stopOpacity=".6" /><stop offset="1" stopColor="var(--gold)" stopOpacity="0" /></linearGradient>
    </defs>
    <rect width="64" height="64" rx="15" fill="url(#logo-bg)" />
    <path d="M32 32 L32 10 A22 22 0 0 1 51.05 21 Z" fill="url(#logo-sweep)" />
    <line x1="32" y1="32" x2="32" y2="10" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" />
    <circle cx="32" cy="32" r="22" fill="none" stroke="url(#logo-ring)" strokeWidth="4" />
    <circle cx="32" cy="32" r="12" fill="none" stroke="var(--malachite)" strokeWidth="2.6" />
    <circle cx="32" cy="32" r="4.2" fill="var(--gold)" />
    <circle cx="45.5" cy="20.5" r="4.6" fill="var(--malachite)" />
    <circle cx="19" cy="45" r="4.2" fill="var(--ember)" />
  </svg>;
}
