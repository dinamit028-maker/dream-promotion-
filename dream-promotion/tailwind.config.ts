import type { Config } from 'tailwindcss';

/** Every color is a CSS variable, so the design system lives in globals.css
 *  and light/dark switch without touching a single component. */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-2': 'var(--bg-2)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        primary: 'var(--primary)',
        'primary-soft': 'var(--primary-soft)',
        pink: 'var(--pink)',
        peach: 'var(--peach)',
        blue: 'var(--blue)',
        mint: 'var(--mint)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      borderRadius: { sm: '10px', md: '16px', lg: '24px', xl: '32px' },
      spacing: { '18': '4.5rem', '30': '7.5rem' },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      backgroundImage: {
        brand: 'var(--grad)',
        'brand-soft': 'var(--grad-soft)',
      },
      keyframes: {
        rise: { from: { opacity: '0', transform: 'translateY(14px)' }, to: { opacity: '1', transform: 'none' } },
        pop: { from: { opacity: '0', transform: 'translateY(18px) scale(.97)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { rise: 'rise .4s cubic-bezier(.22,.8,.3,1)', pop: 'pop .3s cubic-bezier(.22,.8,.3,1)' },
    },
  },
  plugins: [],
};
export default config;
