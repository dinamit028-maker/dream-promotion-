import type { CSSProperties } from 'react';

/** The landing page is always dark, whatever the visitor's system theme.
 *  Overriding the design tokens here keeps shared components (buttons, auth) on-theme. */
export const LANDING_THEME = {
  '--bg': '#0A0814', '--bg-2': '#100D1D', '--surface': '#15112A', '--surface-2': '#1D1838',
  '--ink': '#F4F1FA', '--ink-2': '#C9C2DA', '--muted': '#9A93B2', '--line': 'rgba(255,255,255,.09)',
  '--primary': '#8B66FF', '--primary-soft': '#231B45', '--ok': '#43D2AE',
  colorScheme: 'dark',
} as CSSProperties;

export const REELS = [
  { src: '/showcase/1.mp4', poster: '/showcase/1.jpg', label: 'ריל שנוצר במערכת: תיירת בבית קפה' },
  { src: '/showcase/2.mp4', poster: '/showcase/2.jpg', label: 'ריל שנוצר במערכת: נוסע בשדה תעופה' },
  { src: '/showcase/3.mp4', poster: '/showcase/3.jpg', label: 'ריל שנוצר במערכת: איש עסקים ליד מטוס' },
  { src: '/showcase/4.mp4', poster: '/showcase/4.jpg', label: 'ריל שנוצר במערכת: תייר ברחוב סואן' },
];
