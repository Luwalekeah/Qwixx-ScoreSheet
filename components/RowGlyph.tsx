import type { Color } from '@/lib/scoring';

export const ROW_LABEL: Record<Color, string> = {
  red: 'RED',
  yellow: 'YELLOW',
  green: 'GREEN',
  blue: 'BLUE',
};

export const ROW_DIRECTION: Record<Color, string> = {
  red: '2 to 12',
  yellow: '2 to 12',
  green: '12 to 2',
  blue: '12 to 2',
};

export const ROW_CLASSES: Record<Color, { card: string; ink: string; edge: string }> = {
  red: { card: 'bg-qx-red-tint', ink: 'text-qx-red-ink', edge: 'border-qx-red-edge' },
  yellow: { card: 'bg-qx-yellow-tint', ink: 'text-qx-yellow-ink', edge: 'border-qx-yellow-edge' },
  green: { card: 'bg-qx-green-tint', ink: 'text-qx-green-ink', edge: 'border-qx-green-edge' },
  blue: { card: 'bg-qx-blue-tint', ink: 'text-qx-blue-ink', edge: 'border-qx-blue-edge' },
};

interface RowGlyphProps {
  color: Color;
  className?: string;
}

export function RowGlyph({ color, className }: RowGlyphProps) {
  const common = { 'aria-hidden': true as const, className, viewBox: '0 0 24 24', width: 16, height: 16 };

  switch (color) {
    case 'red':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill="currentColor" />
        </svg>
      );
    case 'yellow':
      return (
        <svg {...common}>
          <polygon points="12,3 21,20 3,20" fill="currentColor" />
        </svg>
      );
    case 'green':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" fill="currentColor" />
        </svg>
      );
    case 'blue':
      return (
        <svg {...common}>
          <polygon points="12,2 22,12 12,22 2,12" fill="currentColor" />
        </svg>
      );
  }
}
