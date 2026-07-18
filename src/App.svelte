<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "svelte-i18n";
  import { locale } from "$lib/i18n";
  import { Languages, CheckCircle2, Loader2 } from "@lucide/svelte";
  import { getAppInfo, type AppInfo } from "$lib/tauri/commands";

  let info: AppInfo | null = null;
  let error: string | null = null;
  let loading = true;

  onMount(async () => {
    try {
      info = await getAppInfo();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  });

  function toggleLocale() {
    locale.update((v) => (v === "zh-CN" ? "en-US" : "zh-CN"));
  }
</script>

<main class="flex h-screen w-screen flex-col bg-surface text-gray-100">
  <!-- Title bar placeholder (real chrome comes later; for now this is the visual anchor) -->
  <header
    class="flex items-center justify-between border-b border-surface-border px-5 py-3"
  >
    <div>
      <h1 class="text-base font-semibold tracking-wide">
        $_("app.title")
      </h1>
      <p class="text-xs text-gray-400">$_("app.subtitle")</p>
    </div>
    <button
      class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:bg-surface-hover"
      on:click={toggleLocale}
      title={$_("menu.language")}
    >
      <Languages size={16} />
      <span>{$locale === "zh-CN" ? "中文" : "EN"}</span>
    </button>
  </header>

  <!-- Body: Phase-0 verification panel -->
  <section class="flex flex-1 items-center justify-center p-8">
    <div
      class="w-full max-w-xl rounded-xl border border-surface-border bg-surface-card p-8 shadow-xl"
    >
      {#if loading}
        <div class="flex items-center gap-3 text-gray-300">
          <Loader2 size={20} class="animate-spin" />
          <span>$_("boot.envCheck")</span>
        </div>
      {:else if error}
        <div class="text-red-400">
          <p class="font-semibold">IPC error</p>
          <pre class="mt-2 whitespace-pre-wrap text-xs">{error}</pre>
        </div>
      {:else}
        <div class="flex items-center gap-3 text-green-400">
          <CheckCircle2 size={20} />
          <span>$_("boot.envOk")</span>
        </div>
        <dl class="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-gray-400">name</dt>
          <dd class="font-mono">{info?.name}</dd>
          <dt class="text-gray-400">version</dt>
          <dd class="font-mono">{info?.version}</dd>
          <dt class="text-gray-400">rustc</dt>
          <dd class="font-mono">{info?.rustc}</dd>
        </dl>
      {/if}
    </div>
  </section>
</main>
