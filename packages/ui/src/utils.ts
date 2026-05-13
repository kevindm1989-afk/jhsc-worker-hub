import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose className strings with conditional logic (clsx) and Tailwind
 * conflict resolution (tailwind-merge). The canonical helper for any
 * component that takes a `className` prop.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
