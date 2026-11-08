<script lang="ts">
  import { onMount } from "svelte";
  let { eventId, admin = false }: { eventId: string; admin?: boolean } = $props();
  let messages: Array<{ id: string; display_name: string; body: string; created_at: string }> = $state([]);
  let name = $state("");
  let body = $state("");
  let notice = $state("");
  let busy = $state(false);

  async function refresh() {
    try {
      const response = await fetch(`/public/events/${eventId}/schedule/messages`);
      if (!response.ok) throw new Error();
      messages = (await response.json()).messages;
    } catch { notice = "会話を読み込めませんでした。"; }
  }
  async function send() {
    busy = true;
    try {
      const response = await fetch(`/public/events/${eventId}/schedule/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, message: body }) });
      if (!response.ok) throw new Error();
      body = ""; notice = "投稿しました。"; await refresh();
    } catch { notice = "投稿できませんでした。時間をおいて再度お試しください。"; }
    finally { busy = false; }
  }
  async function remove(id: string) {
    if (!confirm("この投稿を削除しますか？")) return;
    try {
      const response = await fetch(`/api/events/${eventId}/schedule/messages/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error();
      await refresh();
    } catch { notice = "削除できませんでした。"; }
  }
  onMount(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); });
</script>

<section aria-label="日程の相談">
  <h3>時間や場所を相談</h3>
  <p class="muted">このリンクを知っている人は会話を読んだり投稿したりできます。住所などの個人情報は書かないでください。最新100件を表示します。</p>
  {#if messages.length === 0}<p>まだ投稿はありません。</p>{:else}<ul>{#each messages as message (message.id)}<li><strong>{message.display_name}</strong> <small>{message.created_at} UTC</small><p style="white-space: pre-wrap">{message.body}</p>{#if admin}<button type="button" class="quiet" onclick={() => void remove(message.id)}>削除</button>{/if}</li>{/each}</ul>{/if}
  <form onsubmit={(event) => { event.preventDefault(); void send(); }}>
    <label>お名前<input bind:value={name} maxlength="100" required /></label>
    <label>メッセージ<textarea bind:value={body} maxlength="2000" required></textarea></label>
    <button disabled={busy}>投稿する</button>
  </form>
  {#if notice}<p aria-live="polite">{notice}</p>{/if}
</section>
