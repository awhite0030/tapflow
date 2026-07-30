// Deterministic avatar colour from a display name. Lives here rather than in UserAvatar.tsx so the
// component file exports only components — a module that mixes the two breaks Vite's Fast Refresh
// for every consumer of the file.
const PALETTE_SIZE = 6;

function hashName(name: string): number {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(hash);
}

export function avatarColors(name: string): { bg: string; fg: string } {
  const i = (hashName(name) % PALETTE_SIZE) + 1;
  return {
    bg: `hsl(var(--avatar-${i}-bg))`,
    fg: `hsl(var(--avatar-${i}-fg))`,
  };
}
