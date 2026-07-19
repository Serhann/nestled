import colors from 'tailwindcss/colors';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './*.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm & friendly neutrals: remap `gray-*` to Tailwind's warm `stone`
        // scale so the whole app picks up a warmer tone with no per-file edits.
        gray: colors.stone,
      },
      borderRadius: {
        // Slightly rounder by default for a friendlier feel (harmonizes the
        // whole app, including the management panels that use rounded-lg).
        lg: '0.75rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        // Soft, warm-tinted elevation.
        sm: '0 1px 2px 0 rgb(41 37 36 / 0.06)',
        DEFAULT: '0 1px 3px 0 rgb(41 37 36 / 0.08), 0 1px 2px -1px rgb(41 37 36 / 0.06)',
        md: '0 4px 12px -2px rgb(41 37 36 / 0.10), 0 2px 6px -3px rgb(41 37 36 / 0.06)',
        lg: '0 12px 28px -6px rgb(41 37 36 / 0.14), 0 6px 12px -6px rgb(41 37 36 / 0.08)',
        xl: '0 24px 48px -12px rgb(41 37 36 / 0.18)',
      },
      keyframes: {
        'pop-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'pop-in': 'pop-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
