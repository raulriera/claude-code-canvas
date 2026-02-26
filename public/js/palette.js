export const Palette = {
  background: '#0C0C0C',
  surface: '#171717',
  gridLine: '#131313',
  border: '#1F1F1F',

  textPrimary: '#E5E5E5',
  textSecondary: '#A3A3A3',
  textMuted: '#525252',

  hubText: '#0D0D0D',
  archivedCardFill: '#101010',
  branchFill: '#1A1A1A',

  green: '#22C55E',
  blue: '#3B82F6',
  amber: '#F59E0B',
  purple: '#A855F7',
  red: '#EF4444',
  teal: '#0FD1B8',

  projectColors: [
    '#22C55E', // green
    '#3B82F6', // blue
    '#F59E0B', // amber
    '#A855F7', // purple
    '#EF4444', // red
    '#0FD1B8', // teal
    '#EC4899', // pink
    '#F97316', // orange
    '#06B6D4', // cyan
    '#84CC16', // lime
    '#8B5CF6', // violet
    '#14B8A6', // emerald
  ],
};

export function statusColor(status) {
  switch (status) {
    case 'running': return Palette.blue;
    case 'needsInput': return Palette.green;
    case 'error': return Palette.red;
    case 'archived': return Palette.textMuted;
    default: return Palette.textMuted;
  }
}

export function hexToRGBA(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
