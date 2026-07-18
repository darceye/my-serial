/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{svelte,js,ts}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Win11 Fluent-inspired surface tokens
        surface: {
          DEFAULT: "#1f1f1f",
          card: "#2b2b2b",
          hover: "#333333",
          border: "#404040",
        },
        accent: {
          DEFAULT: "#60cdff",
          hover: "#4db8eb",
        },
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
