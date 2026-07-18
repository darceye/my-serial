import "./styles/app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initI18n } from "$lib/i18n";

// Svelte 5 uses the `mount()` function instead of `new App()`.
// Initialize i18n first so the first paint has the correct locale.
async function bootstrap() {
  await initI18n();
  mount(App, {
    target: document.getElementById("app")!,
  });
}

bootstrap();
