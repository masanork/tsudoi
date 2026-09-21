<script lang="ts">
  import { onMount } from "svelte";

  type ParticipantTicket = { id: string; status: string; event_name: string; starts_at: string; ends_at: string; timezone: string; venue_name: string | null; cancellation_closes_at: string | null };
  let token = "";
  let organizationId = "";
  let events: Array<{ id: string; name: string; starts_at: string; status: string }> = [];
  let message = "API トークンと組織 ID を入力してください。";
  let eventName = "";
  let startsAt = "";
  let endsAt = "";
  let ticketLink = "";
  let checkinMessage = "";
  let participantTicket: ParticipantTicket | null = null;
  let participantMessage = "チケットを確認しています。";
  const ticketPage = typeof window !== "undefined" && window.location.pathname === "/ticket";

  onMount(() => { if (ticketPage) void loadParticipantTicket(); });

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
  async function loadParticipantTicket() {
    try {
      const response = await fetch("/api/participant/ticket", { credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "ticket_not_found");
      participantTicket = body; participantMessage = "";
    } catch { participantMessage = "このチケットリンクは期限切れか、すでに使用されています。メールから新しいリンクを開いてください。"; }
  }
  async function cancelParticipantTicket() {
    try {
      const response = await fetch("/api/participant/ticket/cancel", { method: "POST", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "cancellation_unavailable");
      participantMessage = "参加をキャンセルしました。"; await loadParticipantTicket();
    } catch { participantMessage = "このチケットは現在キャンセルできません。"; }
  }
  async function checkInTicketLink() {
    try {
      const linkToken = new URL(ticketLink).pathname.split("/").filter(Boolean).at(-1);
      if (!linkToken) throw new Error("invalid_ticket_link");
      const result = await api("/tickets/check-in-link", { method: "POST", body: JSON.stringify({ linkToken }) });
      checkinMessage = result.outcome === "accepted" ? "受付が完了しました。" : `受付できません: ${result.outcome}`;
    } catch (error) { checkinMessage = error instanceof Error ? error.message : "受付に失敗しました。"; }
  }
</script>

<svelte:head><meta name="description" content="軽量なイベント名簿・受付管理" /></svelte:head>
<main>
{#if ticketPage}
  <header><p class="eyebrow">YOUR TICKET</p><h1>tsudoi</h1><p>参加者チケット</p></header>
  {#if participantTicket}
    <section aria-labelledby="ticket-title"><h2 id="ticket-title">{participantTicket.event_name}</h2>
      <p><strong>状態: {participantTicket.status}</strong></p>
      <p>{participantTicket.starts_at} – {participantTicket.ends_at} ({participantTicket.timezone})</p>
      {#if participantTicket.venue_name}<p>会場: {participantTicket.venue_name}</p>{/if}
      {#if participantTicket.status === "issued"}<button onclick={cancelParticipantTicket}>参加をキャンセルする</button>{/if}
    </section>
  {:else}<p class="notice" aria-live="polite">{participantMessage}</p>{/if}
{:else}
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
  <section aria-labelledby="check-in"><h2 id="check-in">QR 受付</h2>
    <p>チケット QR から読み取ったリンクを貼り付けてください。</p>
    <form onsubmit={(event) => { event.preventDefault(); void checkInTicketLink(); }}>
      <label>チケットリンク<input bind:value={ticketLink} type="url" inputmode="url" required /></label>
      <button>受付する</button>
    </form>
    {#if checkinMessage}<p class="notice" aria-live="polite">{checkinMessage}</p>{/if}
  </section>
{/if}
</main>
