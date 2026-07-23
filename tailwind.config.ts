import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#0d0b08",
          panel: "#16130d",
          panel2: "#1e1a12",
          border: "#3d3524",
          amber: "#f6b44b",
          green: "#39d98a",
          red: "#ff5c7a",
          cyan: "#56c7ff",
          muted: "#9a917e"
        },
        wow: {
          poor: "#9d9d9d",
          common: "#ffffff",
          uncommon: "#1eff00",
          rare: "#0070dd",
          epic: "#a335ee",
          legendary: "#ff8000",
          gold: "#ffd100",
          silver: "#c7c7cf",
          copper: "#eda55f"
        }
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Inter", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-geist-mono)", "JetBrains Mono", "Consolas", "monospace"]
      }
    }
  },
  plugins: []
};

export default config;