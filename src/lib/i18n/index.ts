import {
  addMessages,
  init,
  getLocaleFromNavigator,
  locale as $locale,
} from "svelte-i18n";
import { writable, get } from "svelte/store";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

const STORAGE_KEY = "myserial.locale";

function pickInitialLocale(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return saved;
  const nav = getLocaleFromNavigator();
  return nav?.startsWith("zh") ? "zh-CN" : "en-US";
}

/** Persisted locale preference, mirrored to svelte-i18n's store. */
export const locale = writable<string>(pickInitialLocale());

locale.subscribe((v) => {
  localStorage.setItem(STORAGE_KEY, v);
  $locale.set(v);
});

let initialized = false;

export async function initI18n(): Promise<void> {
  if (initialized) return;
  addMessages("zh-CN", zhCN);
  addMessages("en-US", enUS);
  await init({
    fallbackLocale: "en-US",
    initialLocale: get(locale),
  });
  initialized = true;
}
