import "./styles/app.css";
import App from "./App.svelte";
import { initI18n } from "./lib/i18n";

// Initialize i18n (and the rest of the app) without top-level await, since
// esbuild's default browser target doesn't allow it.
async function bootstrap() {
  await initI18n();
  new App({
    target: document.getElementById("app")!,
  });
}

bootstrap();
