import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn-canonical Button. Hand-written rather than via `shadcn add` so
// every line is reviewable and the file is locked to the JHSC token set.

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-border bg-card text-foreground hover:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'text-foreground hover:bg-muted',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        // Per S5 F-P2: shadcn's stock `sm` and `default` sizes ship at
        // 32px / 36px which fail CLAUDE.md mobile-primary "Touch
        // targets ≥ 44pt" (WCAG 2.5.5). The fix bumps the responsive
        // floor on mobile (44pt) and collapses back to shadcn-stock
        // on `md:` (768px+) where pointer accuracy is finer. The
        // class names keep the desktop-compact behavior for systemic
        // surfaces (top-bar, dense data tables) that need to remain
        // information-dense at desktop.
        default: 'h-11 px-4 py-2 md:h-9',
        sm: 'h-11 rounded-md px-3 text-xs md:h-8',
        lg: 'h-11 rounded-md px-6 md:h-10',
        icon: 'h-11 w-11 md:h-9 md:w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
