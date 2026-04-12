/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Fraunces"', 'ui-serif', 'Georgia', 'serif'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Warm off-white paper surfaces.
        page:    '#f5efde',  // page background — warm cream
        card:    '#faf5e4',  // raised surfaces — slightly brighter
        rule:    '#d9cea8',  // dividers / borders — beige
        // Warm deep ink grayscale for text.
        ink: {
          50:  '#faf5e4',
          100: '#e8dfbf',
          200: '#c9be98',
          300: '#9f9472',
          400: '#70604e',  // captions / muted
          500: '#544738',
          600: '#3a2f24',  // body emphasis
          700: '#2a2219',
          800: '#1c1610',  // primary text
          900: '#110d08',  // deepest
        },
        // Brand accent — oxblood, scholarly, warm on cream.
        accent: {
          DEFAULT: '#7c2d12',
          soft:    '#923e26',
          tint:    '#eecfbe',
        },
        // Semantic verdict colors.
        yes: '#2e5e3e',    // forest green for correct
        no:  '#92400e',    // burnt amber for wrong (distinct from accent)
      },
    },
  },
  plugins: [],
};
