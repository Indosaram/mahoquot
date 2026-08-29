/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        panel: "var(--panel)",
        "panel-2": "var(--panel-2)",
        "panel-3": "var(--panel-3)",
        line: "var(--line)",
        "line-soft": "var(--line-soft)",
        fg: "var(--fg)",
        "fg-dim": "var(--fg-dim)",
        "fg-faint": "var(--fg-faint)",
        accent: "var(--accent)",
        "accent-dim": "var(--accent-dim)",
        ok: "var(--ok)",
        "ok-dim": "var(--ok-dim)",
        warn: "var(--warn)",
        "warn-dim": "var(--warn-dim)",
        bad: "var(--bad)",
        "bad-dim": "var(--bad-dim)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Text"',
          "Inter",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          '"SF Mono"',
          '"JetBrains Mono"',
          "Menlo",
          "monospace",
        ],
      },
      borderRadius: {
        card: "12px",
      },
    },
  },
  plugins: [],
};
