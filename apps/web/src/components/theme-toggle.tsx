import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type Theme } from './theme-provider';
import { cn } from '@/lib/utils';

const NEXT_THEME: Record<Theme, Theme> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const LABEL: Record<Theme, string> = {
  light: 'Theme: light. Click to switch to dark.',
  dark: 'Theme: dark. Click to switch to system.',
  system: 'Theme: system. Click to switch to light.',
};

export function ThemeToggle({ className }: { className?: string }): JSX.Element {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <button
      type="button"
      aria-label={LABEL[theme]}
      title={LABEL[theme]}
      onClick={() => setTheme(NEXT_THEME[theme])}
      className={cn(
        // Mobile touch target: 44px (h-11 w-11) per CLAUDE.md mobile-primary
        // patterns. Desktop collapses to h-9 w-9 to keep the 56px top-bar.
        'flex h-11 w-11 items-center justify-center rounded-md text-foreground/70 transition-colors md:h-9 md:w-9',
        'hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
