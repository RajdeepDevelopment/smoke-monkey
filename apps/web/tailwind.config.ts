import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark-first AI developer product palette
        bg: {
          DEFAULT: '#0B0F14',
          elevated: '#172033',
        },
        surface: {
          950: '#0B0F14',
          900: '#111827',
          800: '#1a2333',
          700: '#263244',
          600: '#334155',
        },
        primary: {
          DEFAULT: '#7C3AED',
          hover: '#8B5CF6',
          subtle: 'rgba(124, 58, 237, 0.15)',
        },
        accent: {
          DEFAULT: '#06B6D4',
          hover: '#22d3ee',
        },
        success: {
          DEFAULT: '#22C55E',
        },
        warning: {
          DEFAULT: '#F59E0B',
        },
        error: {
          DEFAULT: '#EF4444',
        },
        ink: {
          primary: '#F8FAFC',
          secondary: '#94A3B8',
          muted: '#64748B',
        },
      },
      borderRadius: {
        card: '14px',
      },
    },
  },
  plugins: [],
};

export default config;
