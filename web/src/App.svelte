<script lang="ts">
  let token = "";
  let organizationId = "";
  let events: Array<{ id: string; name: string; starts_at: string; status: string }> = [];
  let message = "API トークンと組織 ID を入力してください。";
  let eventName = "";
  let startsAt = "";
  let endsAt = "";

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "リクエストに失敗しました");
    return body;
  }
  async function loadEvents() {
    try { events = await api(`/organizations/${organizationId}/events`); message = `${events.length} 件のイベントを読み込みました。`; }
    catch (error) { message = error instanceof Error ? error.message : "読み込みに失敗しました。"; }
  }
  async function createEvent() {
    try {
      await api(`/organizations/${organizationId}/events`, { method: "POST", body: JSON.stringify({ name: eventName, startsAt, endsAt, registrationMode: "hybrid" }) });
      eventName = ""; await loadEvents(); message = "イベントを作成しました。";
    } catch (error) { message = error instanceof Error ? error.message : "作成に失敗しました。"; }
  }
</script>

<svelte:head><meta name="description" content="軽量なイベント名簿・受付管理" /></svelte:head>
<main>
  <header><p class="eyebrow">EVENT ROSTER</p><h1>tsudoi</h1><p>会場の名簿と受付を、静かに確実に。</p></header>
  <p class="notice" aria-live="polite">{message}</p>
  <section aria-labelledby="connection"><h2 id="connection">管理者接続</h2>
    <label>API トークン<input bind:value={token} type="password" autocomplete="off" /></label>
    <label>組織 ID<input bind:value={organizationId} /></label>
    <button onclick={loadEvents}>イベントを読み込む</button>
  </section>
  <section aria-labelledby="new-event"><h2 id="new-event">新しいイベント</h2>
    <form onsubmit={(event) => { event.preventDefault(); void createEvent(); }}>
      <label>イベント名<input bind:value={eventName} required /></label>
      <label>開始日時<input bind:value={startsAt} type="datetime-local" required /></label>
      <label>終了日時<input bind:value={endsAt} type="datetime-local" required /></label>
      <button>作成する</button>
    </form>
  </section>
  <section aria-labelledby="events"><h2 id="events">イベント</h2>
    {#if events.length === 0}<p>まだイベントがありません。</p>{:else}<ul>{#each events as event}<li><strong>{event.name}</strong><span>{event.starts_at} · {event.status}</span></li>{/each}</ul>{/if}
  </section>
</main>
