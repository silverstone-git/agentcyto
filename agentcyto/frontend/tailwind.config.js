/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          500: '#0a84ff',
          600: '#0066cc',
          900: '#073b6e',
        },
        ink: {
          0: '#ffffff',
          50: '#f2f2f7',
          100: '#e5e5ea',
          200: '#d1d1d6',
          300: '#c7c7cc',
          400: '#aeb1b9',
          500: '#8e8e93',
          600: '#636366',
          700: '#48484a',
          800: '#3a3a3c',
          900: '#2c2c2e',
          950: '#1c1c1e',
          1000: '#0a0a0b',
        },
        surface: {
          base: '#0a0a0b',
          elevated: '#17171a',
          card: '#1c1c1e',
          border: '#2c2c2e',
        },
        success: '#30d158',
        warn: '#ffd60a',
        danger: '#ff453a',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xl: '16px',
        '2xl': '22px',
        '3xl': '28px',
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0, 0, 0, 0.35)',
        glow: '0 0 40px rgba(10, 132, 255, 0.15)',
      },
      animation: {
        'pulse-soft': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'typing': 'typing 1.2s infinite ease-in-out',
      },
      keyframes: {
        typing: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
