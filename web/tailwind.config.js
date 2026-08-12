/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        cream: '#FBF3E7',
        'cream-deep': '#F3E7D4',
        paper: '#FFFDF9',
        ink: '#3A2A1D',
        'ink-soft': '#6B5C4F',
        brown: '#3E2B1E',
        'brown-soft': '#5A4433',
        sage: '#8FA968',
        'sage-deep': '#5E7A3E',
        'sage-pale': '#D9E4C6',
        coral: '#EA7A41',
        'coral-pale': '#FBD9C2',
        mustard: '#F4B93E',
        'mustard-pale': '#FBE7B8',
        lavender: '#A79BE0',
        'lavender-pale': '#E4E0F7',
      },
      fontFamily: {
        display: ['"Baloo 2"', 'cursive', 'sans-serif'],
        body: ['Poppins', 'sans-serif'],
      },
      borderRadius: {
        md: '16px',
        lg: '24px',
        xl: '32px',
        pill: '999px',
      },
      boxShadow: {
        soft: '0 20px 40px -20px rgba(58,42,29,0.25)',
        'soft-sm': '0 10px 22px -12px rgba(58,42,29,0.35)',
        fab: '0 12px 24px -10px rgba(94,122,62,0.6)',
      },
    },
  },
  plugins: [],
}
