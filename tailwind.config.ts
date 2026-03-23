import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: "#0a0b10", card: "#12141f", hover: "#1a1d2e", border: "#222538" },
        accent: { DEFAULT: "#6366f1", green: "#22c55e", red: "#ef4444", amber: "#f59e0b", cyan: "#06b6d4" },
      },
    },
  },
  plugins: [],
};

export default config;
