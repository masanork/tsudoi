<script lang="ts">
  import QRCode from "qrcode";
  import { formatUtcTimestamp } from "./time";

  type Api = (path: string, init?: RequestInit) => Promise<any>;
  type Venue = { id: string; name: string };
  type Attendee = { id: string; ticket_id: string; name: string; affiliation?: string | null; venue_id?: string | null; ticket_status: string };
  type Request = { requestId: string; qrToken: string; attendeeId: string; ticketId: string; venueId: string; kind: "additional" | "replacement"; reason: string };
  type Card = { id: string; kind: "additional" | "replacement"; url: string; png: string; issuedAt?: string; expiresAt?: string; active: boolean; attendeeId: string; attendeeName: string; legacyCredentialInvalidated?: boolean };

  export let eventId: string;
  export let eventName: string;
  export let role: string;
  export let venues: Venue[] = [];
  export let attendees: Attendee[] = [];
  export let api: Api;

  $: canWrite = role !== "viewer";
  $: isAdmin = role === "owner" || role === "admin";
  $: eligibleAttendees = attendees.filter((attendee) => ["issued", "checked_in"].includes(attendee.ticket_status));
  $: selectedAttendee = eligibleAttendees.find((attendee) => attendee.id === attendeeId) ?? null;
  let attendeeId = "";
  let venueId = "";
  let reason = "";
  let card: Card | null = null;
  let pending: Request | null = null;
  let busy = false;
  let errorMessage = "";
  let statusMessage = "";

  $: if (role === "staff" && venues.length && !venueId) venueId = venues[0].id;
  $: if (card && card.attendeeId !== attendeeId) card = null;

  function createToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function issueCard(kind: "additional" | "replacement") {
    if (!selectedAttendee || busy || pending) return;
    if (kind === "replacement" && (!isAdmin || reason.trim().length < 3)) return;
    if (role === "staff" && !venueId) { errorMessage = "担当会場を選択してください。"; return; }
    const request: Request = {
      requestId: crypto.randomUUID(), qrToken: createToken(), attendeeId: selectedAttendee.id,
      ticketId: selectedAttendee.ticket_id, venueId, kind, reason: reason.trim(),
    };
    pending = request;
    await sendRequest(request);
  }

  async function sendRequest(request: Request, retryingUnknown = false) {
    busy = true; errorMessage = ""; statusMessage = "紙QRカードを発行しています…";
    const path = `/events/${eventId}/attendees/${request.attendeeId}/qr-cards${request.kind === "replacement" ? "/reissue" : ""}`;
    const body = { requestId: request.requestId, qrToken: request.qrToken, venueId: request.venueId || undefined, ...(request.kind === "replacement" ? { reason: request.reason } : {}) };
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body) });
      const responseCard = result.card ?? {};
      const url = responseCard.url ?? cardUrl(request);
      const png = responseCard.qrPngDataUrl ?? await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 4, width: 640 });
      card = {
        id: responseCard.id, kind: responseCard.kind ?? request.kind, url, png,
        issuedAt: responseCard.issued_at, expiresAt: responseCard.expires_at, active: responseCard.active !== false,
        attendeeId: request.attendeeId, attendeeName: eligibleAttendees.find((attendee) => attendee.id === request.attendeeId)?.name ?? "参加者",
        legacyCredentialInvalidated: result.legacyCredentialInvalidated,
      };
      pending = null;
      reason = "";
      statusMessage = request.kind === "replacement"
        ? `紛失カードを再発行しました。以前の受付QRを ${result.revokedCount ?? "すべて"} 件無効にしました。`
        : "追加の紙QRカードを発行しました。以前の受付QRも引き続き使用できます。";
      if (card.legacyCredentialInvalidated) statusMessage += " 旧形式のチケット本人用リンクも無効になりました。本人の再認証にはメールのマジックリンクを使用してください。";
    } catch (error) {
      const status = errorStatus(error);
      errorMessage = friendly(error);
      if (retryingUnknown && status >= 400 && status < 500 && status !== 429) {
        statusMessage = "前回の発行結果を確認できません。権限や担当会場が変わった可能性があります。操作を保留して管理者に確認してください。";
      } else if (!retryingUnknown && status >= 400 && status < 500 && status !== 429) {
        pending = null;
        statusMessage = "入力内容を確認してください。カードは発行されていません。";
      } else {
        statusMessage = "応答を確認できませんでした。前回の発行結果を再確認してください。";
      }
    } finally { busy = false; }
  }

  async function reconcile() {
    const request = pending;
    if (!request || busy) return;
    busy = true; statusMessage = "前回のカード発行結果を確認しています…"; errorMessage = "";
    try {
      const result = await api(`/events/${eventId}/attendees/${request.attendeeId}/qr-cards/by-request/${request.requestId}`);
      const metadata = result.card ?? {};
      const url = cardUrl(request);
      const png = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 4, width: 640 });
      const active = metadata.active === true;
      card = { id: metadata.id, kind: metadata.kind ?? request.kind, url, png, issuedAt: metadata.issued_at, expiresAt: metadata.expires_at, active,
        attendeeId: request.attendeeId, attendeeName: eligibleAttendees.find((attendee) => attendee.id === request.attendeeId)?.name ?? "参加者",
        legacyCredentialInvalidated: result.legacyCredentialInvalidated === true };
      pending = null;
      statusMessage = active ? "カードの発行を確認しました。" : "発行記録はありますが、このQRはすでに失効しています。新しいカードを発行してください。";
      if (request.kind === "replacement") {
        statusMessage = `紛失カードの再発行を確認しました。以前の受付QRを ${result.revokedCount ?? "すべて"} 件無効にしました。`;
        if (card.legacyCredentialInvalidated) statusMessage += " 旧形式のチケット本人用リンクも無効になりました。本人の再認証にはメールのマジックリンクを使用してください。";
      }
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) {
        busy = false;
        await sendRequest(request, true);
        return;
      }
      errorMessage = friendly(error);
      statusMessage = "前回の結果を確認できませんでした。権限と担当会場を確認してから再確認してください。";
    } finally { busy = false; }
  }

  function cardUrl(request: Request) {
    return `${window.location.origin}/public/tickets/${encodeURIComponent(request.ticketId)}/check-in/${encodeURIComponent(request.qrToken)}`;
  }

  async function printCard() {
    if (!card?.active) return;
    const printWindow = window.open("about:blank", "_blank");
    if (!printWindow) { errorMessage = "印刷画面を開けませんでした。ブラウザーのポップアップ設定を確認してください。"; return; }
    const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
    printWindow.document.write(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>紙QRカード</title><style>body{font-family:system-ui,sans-serif;margin:24px}.card{border:1px solid #777;border-radius:12px;padding:24px;max-width:520px;text-align:center}img{width:320px;height:320px;object-fit:contain}.event{color:#555}</style><main class="card"><h1>${escape(card.attendeeName)}</h1><p class="event">${escape(eventName)}</p><img src="${card.png}" alt="受付QRコード"></main><script>window.onload=()=>window.print()<\/script></html>`);
    printWindow.document.close();
  }

  function errorStatus(error: unknown) { return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 0; }
  function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : ""; }
  function friendly(error: unknown) {
    const code = errorCode(error);
    const messages: Record<string, string> = {
      not_found: "参加者またはカードが見つかりません。名簿とイベントを確認してください。",
      venue_required: "担当会場を選択してください。",
      venue_not_assigned: "この会場の担当者ではありません。担当会場を確認してください。",
      invalid_qr_token: "カード情報を作成できませんでした。もう一度お試しください。",
      invalid_reason: "再発行の理由を入力してください。",
      qr_card_request_conflict: "同じ発行操作IDに異なる内容が指定されています。新しい操作でやり直してください。",
    };
    return messages[code] ?? "紙QRカードを発行できませんでした。入力内容と権限を確認してください。";
  }
</script>

{#if canWrite}
<section class="paper-card-panel" aria-labelledby="paper-card-title">
  <h2 id="paper-card-title">紙QRカード</h2>
  <p class="muted">スマホやメールがない参加者にも渡せます。発行後に氏名を確認し、印刷またはPNG保存してください。QRに個人情報は含みません。</p>
  <label>カード発行対象の参加者<select bind:value={attendeeId} disabled={Boolean(pending)}><option value="">参加者を選択</option>{#each eligibleAttendees as attendee (attendee.id)}<option value={attendee.id}>{attendee.name}{attendee.ticket_status === "checked_in" ? "（受付済み）" : ""}</option>{/each}</select></label>
  {#if venues.length}<label>発行する会場<select bind:value={venueId} disabled={Boolean(pending)}><option value="">会場を選択</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{/if}
  <button type="button" disabled={busy || Boolean(pending) || !selectedAttendee || (role === "staff" && !venueId)} onclick={() => void issueCard("additional")}>カードを発行</button>
  <p class="muted">追加カードは以前の受付QRを無効にしません。</p>
  {#if isAdmin && selectedAttendee}
    <details class="replacement">
      <summary>紛失カードを再発行</summary>
      <p class="warning">再発行すると、この参加者の以前の受付QRはすべて無効になります。旧形式のチケットでは本人用リンクも無効になる場合があり、メールのマジックリンクによる再認証が必要です。</p>
      <label>再発行の理由<textarea bind:value={reason} maxlength="500" required placeholder="例: 紙カードを紛失したため" disabled={Boolean(pending)}></textarea></label>
      <button type="button" class="danger-action" disabled={busy || Boolean(pending) || !selectedAttendee || reason.trim().length < 3} onclick={() => void issueCard("replacement")}>紛失カードを再発行</button>
    </details>
  {/if}
  {#if pending}<p class="pending-note" role="status">発行結果を確認できていません。対象者や内容を変えずに再確認してください。</p><button type="button" class="quiet" disabled={busy} onclick={() => void reconcile()}>カード発行結果を再確認</button>{/if}
  {#if card}<article class="paper-card-result" aria-label="発行した紙QRカード">
    <h3>{card.attendeeName}</h3><p>{eventName}</p>
    {#if card.active}<img src={card.png} alt={`${card.attendeeName} の紙QRカード`} /><p class="muted">QRは受付用URLのみを含み、氏名・所属などの情報は含みません。</p>
      <a class="quiet" href={card.png} download={`tsudoi-qr-card-${card.attendeeId}.png`}>PNGを保存</a><button type="button" class="quiet" onclick={() => void printCard()}>印刷する</button>
    {:else}<p class="warning">このQRは現在失効しています。印刷・保存はできません。</p>{/if}
    {#if card.expiresAt}<p class="muted">有効期限: {formatUtcTimestamp(card.expiresAt)}</p>{/if}
  </article>{/if}
  {#if statusMessage}<p role="status" aria-live="polite">{statusMessage}</p>{/if}
  {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
</section>
{/if}

<style>
  .paper-card-panel { border: 1px solid #d8ddd8; border-radius: 10px; padding: 14px; margin: 16px 0; }
  .paper-card-panel > label, .replacement label { display: block; margin: 10px 0; }
  .replacement { border: 1px solid #d97706; border-radius: 8px; padding: 10px; margin: 14px 0; }
  .replacement summary { cursor: pointer; font-weight: 700; }
  .warning { color: #8a3b08; background: #fff7ed; border-radius: 7px; padding: 10px; }
  .danger-action { background: #9a3412; color: white; }
  .paper-card-result { border: 2px solid #14544f; border-radius: 10px; padding: 16px; text-align: center; margin-top: 16px; }
  .paper-card-result img { display: block; width: min(100%, 360px); aspect-ratio: 1; object-fit: contain; margin: 10px auto; }
  .paper-card-result a { display: inline-block; text-decoration: none; }
  .pending-note, .error { padding: 10px; border-radius: 8px; }
  .pending-note { background: #fff7ed; }
  .error { background: #fff1f0; color: #8a1c13; }
</style>
