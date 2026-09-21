<script lang="ts">
  import { onMount } from "svelte";
  import { startRegistration } from "@simplewebauthn/browser";

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
  let selectedEventId = "";
  let metrics: { registrations: number; issued: number; cancelled: number; checked_in: number; not_checked_in: number } | null = null;
  let fieldKey = "";
  let fieldLabel = "";
  let fieldType = "text";
  let fieldOptions = "";
  let fieldRequired = false;
  let fieldMessage = "";
  const fieldKeyPattern = "[a-z][a-z0-9_]{0,62}";
  const registerMatch = typeof window !== "undefined" ? window.location.pathname.match(/^\/events\/([^/]+)\/register$/) : null;
  const registrationEventId = registerMatch?.[1] ?? "";
  let publicEvent: { name: string; description: string; starts_at: string } | null = null;
  let publicFields: Array<{ field_key: string; label: string; field_type: string; required: number; options_json: string }> = [];
  let registrationName = ""; let registrationEmail = ""; let registrationAnswers: Record<string, string | string[] | boolean> = {}; let registrationMessage = "";
  let issuedTicket: { id: string; token: string } | null = null;
  let passkeyMessage = "";
  let participantTicket: ParticipantTicket | null = null;
  let participantMessage = "チケットを確認しています。";
  const ticketPage = typeof window !== "undefined" && window.location.pathname === "/ticket";

  onMount(() => { if (ticketPage) void loadParticipantTicket(); else if (registrationEventId) void loadRegistration(); });

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
  async function loadMetrics(eventId: string) {
    try { selectedEventId = eventId; metrics = await api(`/events/${eventId}/metrics`); }
    catch (error) { message = error instanceof Error ? error.message : "集計を読み込めませんでした。"; }
  }
  async function createField() {
    try {
      const options = fieldOptions.split(/[\n,]/).map((option) => option.trim()).filter(Boolean);
      await api(`/events/${selectedEventId}/form-fields`, { method: "POST", body: JSON.stringify({ key: fieldKey, label: fieldLabel, type: fieldType, required: fieldRequired, options }) });
      fieldKey = ""; fieldLabel = ""; fieldOptions = ""; fieldRequired = false; fieldMessage = "項目を追加しました。";
    } catch (error) { fieldMessage = error instanceof Error ? error.message : "項目を追加できませんでした。"; }
  }
  async function loadRegistration() {
    try { const response = await fetch(`/public/events/${registrationEventId}`); const body = await response.json(); if (!response.ok) throw new Error(); publicEvent = body.event; publicFields = body.fields; }
    catch { registrationMessage = "この申込フォームは利用できません。"; }
  }
  async function register() {
    try { const response = await fetch(`/public/events/${registrationEventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: registrationName, email: registrationEmail || undefined, answers: registrationAnswers }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); issuedTicket = { id: body.ticketId, token: body.ticketToken }; registrationMessage = body.emailQueued ? "申込を受け付け、QRチケットをメールで送付しました。" : "申込を受け付けました。チケットはこの画面から離れる前に保存してください。"; }
    catch (error) { registrationMessage = error instanceof Error ? error.message : "申込に失敗しました。"; }
  }
  async function registerPasskey() {
    if (!issuedTicket) return;
    try {
      if (!window.PublicKeyCredential) throw new Error("この端末はPasskeyに対応していません。");
      passkeyMessage = "Passkeyを登録しています…";
      const optionsResponse = await fetch(`/public/tickets/${issuedTicket.id}/passkeys/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticketToken: issuedTicket.token }) });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error ?? "passkey_options_failed");
      const credential = await startRegistration({ optionsJSON: options.options });
      const verifyResponse = await fetch(`/public/tickets/${issuedTicket.id}/passkeys/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticketToken: issuedTicket.token, challengeId: options.challengeId, response: credential }) });
      const verification = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(verification.error ?? "passkey_verification_failed");
      passkeyMessage = verification.prfCapable ? "Passkeyを登録しました。PRFによる鍵保護が利用可能です。" : "Passkeyを登録しました。この端末ではPRF鍵保護は利用できません。";
    } catch (error) { passkeyMessage = error instanceof Error ? error.message : "Passkeyを登録できませんでした。"; }
  }
  function options(field: { options_json: string }) { try { const value: unknown = JSON.parse(field.options_json); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
  function stringAnswer(key: string) { const value = registrationAnswers[key]; return typeof value === "string" ? value : ""; }
  function setStringAnswer(key: string, value: string) { registrationAnswers = { ...registrationAnswers, [key]: value }; }
  function checkedAnswer(key: string) { return registrationAnswers[key] === true; }
  function setCheckedAnswer(key: string, checked: boolean) { registrationAnswers = { ...registrationAnswers, [key]: checked }; }
  function selectedAnswer(key: string, option: string) { const value = registrationAnswers[key]; return Array.isArray(value) && value.includes(option); }
  function toggleSelectedAnswer(key: string, option: string, checked: boolean) { const current = registrationAnswers[key]; const values = Array.isArray(current) ? current : []; registrationAnswers = { ...registrationAnswers, [key]: checked ? [...new Set([...values, option])] : values.filter((value) => value !== option) }; }
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
{:else if registrationEventId}
  <header><p class="eyebrow">EVENT REGISTRATION</p><h1>tsudoi</h1><p>{publicEvent?.name ?? "申込フォーム"}</p></header>
  {#if publicEvent}<section><h2>{publicEvent.name}</h2><p>{publicEvent.description}</p><p>{publicEvent.starts_at}</p><form onsubmit={(event) => { event.preventDefault(); void register(); }}><label>氏名<input bind:value={registrationName} required /></label><label>メールアドレス<input bind:value={registrationEmail} type="email" /></label>{#each publicFields as field}{#if field.field_type === "multi_select"}<fieldset><legend>{field.label}{#if field.required === 1}（必須）{/if}</legend>{#each options(field) as option}<label class="inline"><input type="checkbox" checked={selectedAnswer(field.field_key, option)} onchange={(event) => toggleSelectedAnswer(field.field_key, option, event.currentTarget.checked)} />{option}</label>{/each}</fieldset>{:else if field.field_type === "checkbox" || field.field_type === "consent"}<label class="inline"><input type="checkbox" checked={checkedAnswer(field.field_key)} onchange={(event) => setCheckedAnswer(field.field_key, event.currentTarget.checked)} required={field.required === 1} />{field.label}</label>{:else}<label>{field.label}{#if field.field_type === "textarea"}<textarea value={stringAnswer(field.field_key)} oninput={(event) => setStringAnswer(field.field_key, event.currentTarget.value)} required={field.required === 1}></textarea>{:else if field.field_type === "single_select"}<select value={stringAnswer(field.field_key)} onchange={(event) => setStringAnswer(field.field_key, event.currentTarget.value)} required={field.required === 1}><option value="">選択してください</option>{#each options(field) as option}<option value={option}>{option}</option>{/each}</select>{:else}<input value={stringAnswer(field.field_key)} oninput={(event) => setStringAnswer(field.field_key, event.currentTarget.value)} required={field.required === 1} type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : "text"} />{/if}</label>{/if}{/each}<button>申し込む</button></form></section>{/if}
  {#if registrationMessage}<p class="notice" aria-live="polite">{registrationMessage}</p>{/if}
  {#if issuedTicket}<section aria-labelledby="passkey-registration"><h2 id="passkey-registration">Passkey を登録する</h2><p>この端末でチケットを安全に再表示できるようにします。PRF対応Passkeyでは、E2EE鍵の保護にも使用します。</p><button onclick={registerPasskey}>Passkey を登録</button>{#if passkeyMessage}<p class="notice" aria-live="polite">{passkeyMessage}</p>{/if}</section>{/if}
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
    {#if events.length === 0}<p>まだイベントがありません。</p>{:else}<ul>{#each events as event}<li><strong>{event.name}</strong><span>{event.starts_at} · {event.status} <button onclick={() => loadMetrics(event.id)}>集計</button></span></li>{/each}</ul>{/if}
  </section>
  {#if metrics}
    <section aria-labelledby="metrics"><h2 id="metrics">イベント集計</h2><p class="muted">Event ID: {selectedEventId}</p>
      <dl class="metrics"><div><dt>申込</dt><dd>{metrics.registrations ?? 0}</dd></div><div><dt>発券</dt><dd>{metrics.issued ?? 0}</dd></div><div><dt>取消</dt><dd>{metrics.cancelled ?? 0}</dd></div><div><dt>受付済</dt><dd>{metrics.checked_in ?? 0}</dd></div><div><dt>未受付</dt><dd>{metrics.not_checked_in ?? 0}</dd></div></dl>
    </section>
  {/if}
  {#if selectedEventId}
    <section aria-labelledby="custom-fields"><h2 id="custom-fields">申込フォームのカスタム項目</h2>
      <form onsubmit={(event) => { event.preventDefault(); void createField(); }}>
        <label>項目キー<input bind:value={fieldKey} pattern={fieldKeyPattern} placeholder="company_name" required /></label>
        <label>表示名<input bind:value={fieldLabel} placeholder="所属" required /></label>
        <label>型<select bind:value={fieldType}><option value="text">短文</option><option value="textarea">長文</option><option value="number">数値</option><option value="date">日付</option><option value="single_select">単一選択</option><option value="multi_select">複数選択</option><option value="checkbox">チェックボックス</option><option value="consent">同意</option></select></label>
        {#if fieldType === "single_select" || fieldType === "multi_select"}<label>選択肢（改行またはカンマ区切り）<textarea bind:value={fieldOptions} required></textarea></label>{/if}
        <label class="inline"><input bind:checked={fieldRequired} type="checkbox" />必須項目</label><button>項目を追加</button>
      </form>
      {#if fieldMessage}<p class="notice" aria-live="polite">{fieldMessage}</p>{/if}
    </section>
  {/if}
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
