/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{svelte,js,ts}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Win11 Fluent-inspired surface tokens. The actual hex values live in
        // CSS variables (src/styles/app.css) and flip between dark and light
        // based on the <html>.light class toggled by the theme store — so
        // every bg-surface / border-surface-border / text-fg* class picks up
        // the active theme automatically, with no per-component overrides.
        surface: {
          DEFAULT: "var(--c-surface)",
          card: "var(--c-surface-card)",
          hover: "var(--c-surface-hover)",
          border: "var(--c-surface-border)",
        },
        accent: {
          DEFAULT: "var(--c-accent)",
          hover: "var(--c-accent-hover)",
        },
        // Foreground gray ramp. Replaces the hard-coded text-gray-* / text-white
        // classes that were scattered across components (which ignored the
        // theme toggle entirely).
        fg: "var(--c-fg)",          // primary text
        "fg-soft": "var(--c-fg-soft)", // secondary labels / hints
        "fg-mute": "var(--c-fg-mute)", // dividers / disabled hints
        "fg-on": "var(--c-fg-on)",     // text sitting on the accent color
      },
      fontFamily: {
        mono: [
          "Cascadia Code",
          "Consolas",
          "Courier New",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
