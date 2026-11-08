<script lang="ts">
  import { onMount } from "svelte";
  let { eventId }: { eventId: string } = $props();
  let publicKey = $state<string | null>(null), enabled = $state(false), message = $state(""), busy = $state(false);
  let key = $derived(`tsudoi-push-owner-${eventId}`);
  function decode(value: string) { const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); }
  function ownerToken() { let value = localStorage.getItem(key); if (!value) { value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join(""); localStorage.setItem(key, value); } return value; }
  onMount(() => { void (async () => { try { const r = await fetch(`/public/events/${eventId}/schedule/push-config`); if (r.ok) publicKey = (await r.json()).publicKey; const registration = await navigator.serviceWorker?.getRegistration("/"); enabled = Boolean(localStorage.getItem(key) && await registration?.pushManager.getSubscription()); } catch { message = "通知設定を確認できませんでした。"; } })(); });
  async function subscribe() {
    if (!publicKey) return;
    busy = true;
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("このブラウザでは通知を利用できません。iPhone・iPad ではホーム画面に追加して開いてください。");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decode(publicKey) });
      const json = subscription.toJSON();
      const response = await fetch(`/public/events/${eventId}/schedule/push-subscriptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth, owner: ownerToken() }) });
      if (!response.ok) throw new Error("通知を登録できませんでした。");
      enabled = true; message = "この端末で確定・変更通知を受け取ります。";
    } catch (error) { message = error instanceof Error ? error.message : "通知を登録できませんでした。"; }
    finally { busy = false; }
  }
  async function unsubscribe() {
    busy = true;
    try {
      const subscription = await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription();
      const owner = localStorage.getItem(key);
      if (subscription && owner) { const response = await fetch(`/public/events/${eventId}/schedule/push-subscriptions`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint, owner }) }); if (!response.ok) throw new Error(); }
      localStorage.removeItem(key); enabled = false; message = "この日程調整の通知を解除しました。";
    } catch { message = "通知を解除できませんでした。"; }
    finally { busy = false; }
  }
</script>

<section aria-label="日程の通知"><h3>確定・変更の通知</h3><p>通知を許可した端末にお知らせします。iPhone・iPad ではホーム画面に追加してから開いてください。</p>{#if !publicKey}<p>通知は現在利用できません。</p>{:else if enabled}<button type="button" disabled={busy} onclick={unsubscribe}>通知を解除</button>{:else}<button type="button" disabled={busy} onclick={subscribe}>通知を受け取る</button>{/if}{#if message}<p aria-live="polite">{message}</p>{/if}</section>
