/** @type {import('tailwindcss').Config} */
// "Organic" design system (imported from Claude Design — JetChat Design.dc.html).
// Warm terracotta accent + olive secondary on a cream canvas, Caprasimo display
// headings + Figtree body, pill-shaped controls. The app uses `blue-*` as its
// primary and `gray-*`/`green-*` semantically, so we remap those palettes to the
// Organic ramps — the whole UI adopts the design with minimal per-file churn.
export default {
  content: ['./index.html', './*.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutrals — warm beige ramp.
        gray: {
          50: '#fbf8f2',
          100: '#f9f4ed',
          200: '#eee7db',
          300: '#dcd3c4',
          400: '#c0b6a5',
          500: '#a19786',
          600: '#82796a',
          700: '#645c50',
          800: '#474238',
          900: '#2e2b25',
        },
        // Primary accent — terracotta. `blue-600` is the brand accent (#c67139).
        blue: {
          50: '#fff7f2',
          100: '#fff2eb',
          200: '#ffe1d0',
          300: '#ffc6a5',
          400: '#f6a06b',
          500: '#d67f48',
          600: '#c67139',
          700: '#8c491a',
          800: '#643312',
          900: '#402310',
        },
        // Secondary accent — olive/sage (online, success, AI copilot).
        green: {
          50: '#f6fae9',
          100: '#f0fae1',
          200: '#e1eecc',
          300: '#ccdbb2',
          400: '#aebf92',
          500: '#8fa073',
          600: '#728157',
          700: '#56633f',
          800: '#3d472b',
          900: '#272e1b',
        },
        // Brand canvas + surfaces (design tokens).
        canvas: '#f5ead8',
        surface: '#ebddc5',
        cream: '#fffcf7',
        ink: '#201e1d',
      },
      fontFamily: {
        sans: ['Figtree', 'ui-rounded', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Caprasimo', 'Figtree', 'Georgia', 'serif'],
      },
      borderRadius: {
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },
      boxShadow: {
        sm: '0 1px 2px color-mix(in srgb, #2e2b25 14%, transparent)',
        DEFAULT: '0 3px 10px color-mix(in srgb, #2e2b25 16%, transparent)',
        md: '0 3px 10px color-mix(in srgb, #2e2b25 16%, transparent)',
        lg: '0 12px 32px color-mix(in srgb, #2e2b25 22%, transparent)',
        xl: '0 20px 48px color-mix(in srgb, #2e2b25 26%, transparent)',
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
