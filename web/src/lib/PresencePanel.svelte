<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { formatUtcTimestamp } from "./time";
  import { QrVideoScanner } from "./qr-scanner";

  type Api = (path: string, init?: RequestInit) => Promise<any>;
  type Venue = { id: string; name: string };
  type Presence = {
    attendee_id: string;
    name: string;
    affiliation?: string | null;
    registration_venue_id?: string | null;
    state: "in" | "out";
    venue_id?: string | null;
    revision: number;
    updated_at?: string | null;
    ticket_status?: string | null;
  };
  type Movement = {
    id: string;
    request_id: string;
    attendee_id: string;
    attendee_name?: string;
    action: "enter" | "exit";
    venue_id: string;
    venue_name?: string;
    revision?: number;
    outcome?: "accepted" | "state_conflict" | "revision_conflict" | string;
    status?: "accepted" | "unsuccessful" | string;
    movement_id?: string | null;
    recorded_at?: string;
    occurred_at?: string | null;
  };
  type MovementPayload = {
    requestId: string;
    attendeeId?: string;
    qrLink?: string;
    action: "enter" | "exit";
    venueId: string;
    expectedRevision: number;
  };

  export let eventId: string;
  export let role: string;
  export let venues: Venue[] = [];
  export let api: Api;

  $: isViewer = role === "viewer";
  $: canChange = role !== "viewer";
  let presenceRows: Presence[] = [];
  let selectedPerson: Presence | null = null;
  let venueCounts: Array<{ venue_id: string; venue_name: string; count: number }> = [];
  let summary = { total_attendees: 0, total_in: 0, total_out: 0, total_entries: 0 };
  let query = "";
  let appliedQuery = "";
  let venueFilter = "";
  let selectedVenueId = "";
  let qrLink = "";
  let selectedByQr = false;
  let history: Movement[] = [];
  let historyCursor: string | null = null;
  let nextCursor: string | null = null;
  let loading = false;
  let submitting = false;
  let scanning = false;
  let scannerLatched = "";
  let video: HTMLVideoElement;
  let qrScanner: QrVideoScanner | null = null;
  let statusMessage = "";
  let errorMessage = "";
  let pendingPayload: MovementPayload | null = null;
  let historyRequestSequence = 0;

  $: selectedVenueName = venues.find((venue) => venue.id === selectedVenueId)?.name ?? "";
  $: personVenueName = venues.find((venue) => venue.id === selectedPerson?.venue_id)?.name ?? "";
  $: assignedVenueName = venues.find((venue) => venue.id === selectedPerson?.registration_venue_id)?.name ?? "";
  $: filteredRows = presenceRows.filter((row) => !venueFilter || row.venue_id === venueFilter || row.registration_venue_id === venueFilter);
  $: if (role === "staff" && venues.length && !venueFilter) {
    venueFilter = venues[0].id;
    selectedVenueId = venues[0].id;
    void loadPresence();
  }

  onMount(() => { if (role !== "staff") void loadPresence(); });
  onDestroy(stopScanner);

  async function loadPresence(search = appliedQuery, append = false) {
    const event = eventId;
    loading = true; errorMessage = "";
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (search) params.set("q", search);
      const scopeVenueId = role === "staff" ? (venueFilter || venues[0]?.id || "") : venueFilter;
      if (scopeVenueId) params.set("venueId", scopeVenueId);
      if (append && nextCursor) params.set("after", nextCursor);
      const result = await api(`/events/${event}/presence?${params}`);
      if (eventId !== event) return;
      presenceRows = append ? [...presenceRows, ...(result.presence ?? [])] : (result.presence ?? []);
      nextCursor = result.nextCursor ?? null;
      summary = result.summary ?? { total_attendees: 0, total_in: 0, total_out: 0, total_entries: 0 };
      venueCounts = result.summary?.venue_in ?? [];
      const current = selectedPerson && presenceRows.find((row) => row.attendee_id === selectedPerson!.attendee_id);
      if (current) selectedPerson = current;
      if (selectedPerson && !append) await loadHistory(false);
    } catch (error) { errorMessage = friendly(error); }
    finally { loading = false; }
  }

  async function searchPeople() {
    if (pendingPayload) return;
    appliedQuery = query.trim();
    presenceRows = []; nextCursor = null;
    await loadPresence(appliedQuery);
  }

  async function selectPerson(person: Presence, byQr = false, proof = "") {
    if (pendingPayload) return;
    selectedPerson = person; selectedByQr = byQr; qrLink = proof;
    if (person.state === "in") selectedVenueId = person.venue_id ?? "";
    statusMessage = ""; errorMessage = "";
    await loadHistory(false);
  }

  async function resolveQr(value = qrLink) {
    if (!value.trim() || submitting || pendingPayload) return;
    submitting = true; statusMessage = "QRを確認しています…"; errorMessage = "";
    try {
      const result = await api(`/events/${eventId}/presence/resolve`, { method: "POST", body: JSON.stringify({ qrLink: value.trim(), ...(selectedVenueId ? { venueId: selectedVenueId } : {}) }) });
      const person: Presence = { ...result, ...(result.presence ?? {}) };
      if (result.operation_venue_id) selectedVenueId = result.operation_venue_id;
      await selectPerson(person, true, value.trim());
      statusMessage = "参加者と現在の在館状態を確認しました。入退館操作を選択してください。";
    } catch (error) { errorMessage = friendly(error); }
    finally { submitting = false; }
  }

  async function recordMovement(action: "enter" | "exit", payload = pendingPayload, fromUnknownRetry = false) {
    if (!payload || submitting) return;
    submitting = true; errorMessage = ""; statusMessage = action === "enter" ? "入館を記録しています…" : "退館を記録しています…";
    try {
      const result = await api(`/events/${eventId}/presence/movements`, { method: "POST", body: JSON.stringify(payload) });
      pendingPayload = null;
      await handleMovementResult(result);
    } catch (error) {
      errorMessage = friendly(error);
      const status = errorStatus(error);
      if (status >= 400 && status < 500 && status !== 429) {
        if (fromUnknownRetry) {
          statusMessage = "前回の結果を確認できません。権限や担当会場が変わった可能性があります。記録が残っている場合があるため、同じ操作の確認を続けてください。";
        } else {
          pendingPayload = null;
          if (errorCode(error) === "revision_conflict" || errorCode(error) === "state_conflict") {
          statusMessage = "状態が他の操作で更新されました。最新状態を読み込み、もう一度操作を選んでください。";
          await refreshSelectedPresence();
          } else statusMessage = "内容を確認してください。入退館記録は更新されていません。";
        }
      } else if (pendingPayload) {
        statusMessage = "応答を確認できませんでした。前回の入退館記録を再確認してください。再送しても二重記録されません。";
      } else pendingPayload = payload;
    } finally { submitting = false; }
  }

  function beginMovement(action: "enter" | "exit") {
    if (!selectedPerson || !canChange || pendingPayload) return;
    const venueId = action === "exit" ? selectedPerson.venue_id : selectedVenueId;
    if (!venueId) { errorMessage = action === "exit" ? "現在の滞在会場が確認できません。状態を再読み込みしてください。" : "入館先の会場を選択してください。"; return; }
    if (action === "enter" && selectedPerson.state !== "out") { errorMessage = "先に現在の会場から退館してください。"; return; }
    if (action === "exit" && selectedPerson.state !== "in") { errorMessage = "現在、在館状態ではありません。状態を再読み込みしてください。"; return; }
    pendingPayload = {
      requestId: crypto.randomUUID(),
      ...(selectedByQr && qrLink ? { qrLink } : { attendeeId: selectedPerson.attendee_id }),
      action, venueId, expectedRevision: selectedPerson.revision,
    };
    void recordMovement(action, pendingPayload);
  }

  async function handleMovementResult(result: any) {
    const outcome = result.outcome;
    if (outcome === "revision_conflict" || outcome === "state_conflict") {
      statusMessage = outcome === "revision_conflict"
        ? "入退館情報が別の操作で更新されていました。最新状態を読み込みました。もう一度操作を選んでください。"
        : "現在の在館状態ではその操作を記録できません。最新状態を確認してください。";
      await refreshSelectedPresence();
      return;
    }
    if (outcome !== "accepted") {
      statusMessage = `入退館を記録できませんでした（${outcome ?? "不明"}）。`;
      return;
    }
    const actionText = result.movement?.action === "enter" ? "入館" : "退館";
    const venueName = venues.find((venue) => venue.id === result.movement?.venue_id)?.name ?? selectedVenueName;
    statusMessage = `${selectedPerson?.name ?? "参加者"}の${venueName ? `${venueName}への` : ""}${actionText}を記録しました。状態を更新しました。`;
    await loadPresence(appliedQuery);
    await refreshSelectedPresence();
  }

  async function retryUnknown() {
    const payload = pendingPayload;
    if (!payload || submitting) return;
    submitting = true; errorMessage = ""; statusMessage = "前回の入退館記録を確認しています…";
    try {
      const result = await api(`/events/${eventId}/presence/movements/by-request/${payload.requestId}`);
      pendingPayload = null;
      await handleMovementResult(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) {
        submitting = false;
        await recordMovement(payload.action, payload, true);
        return;
      }
      errorMessage = friendly(error);
      statusMessage = "前回の結果を確認できませんでした。通信を確認してから、もう一度確認してください。";
    } finally { submitting = false; }
  }

  async function refreshSelectedPresence() {
    const personId = selectedPerson?.attendee_id;
    const event = eventId;
    if (!personId) return;
    try {
      const params = new URLSearchParams({ attendeeId: personId, limit: "1" });
      if (role === "staff" && (venueFilter || venues[0]?.id)) params.set("venueId", venueFilter || venues[0].id);
      const result = await api(`/events/${event}/presence?${params}`);
      if (eventId !== event || selectedPerson?.attendee_id !== personId) return;
      const current = (result.presence ?? []).find((row: Presence) => row.attendee_id === personId);
      if (current) {
        selectedPerson = current;
        presenceRows = [...presenceRows.filter((row) => row.attendee_id !== personId), current];
      } else {
        selectedPerson = null; selectedByQr = false; history = []; historyCursor = null;
        presenceRows = presenceRows.filter((row) => row.attendee_id !== personId);
        statusMessage = "この参加者の現在状態を確認できません。会場や名簿の状態を確認して、もう一度検索してください。";
        return;
      }
      summary = result.summary ?? summary;
      venueCounts = result.summary?.venue_in ?? venueCounts;
      await loadHistory(false);
    } catch (error) { errorMessage = friendly(error); }
  }

  async function loadHistory(append = false) {
    const event = eventId;
    const attendeeId = selectedPerson?.attendee_id;
    const scopedVenueId = role === "staff" ? (venueFilter || venues[0]?.id || "") : "";
    if (!attendeeId) { historyRequestSequence += 1; history = []; historyCursor = null; return; }
    const requestSequence = ++historyRequestSequence;
    try {
      const params = new URLSearchParams({ attendeeId, limit: "50" });
      if (scopedVenueId) params.set("venueId", scopedVenueId);
      if (append && historyCursor) params.set("after", historyCursor);
      const result = await api(`/events/${event}/presence/history?${params}`);
      if (eventId !== event || selectedPerson?.attendee_id !== attendeeId
        || (role === "staff" && (venueFilter || venues[0]?.id || "") !== scopedVenueId)
        || requestSequence !== historyRequestSequence) return;
      history = append ? [...history, ...(result.movements ?? [])] : (result.movements ?? []);
      historyCursor = result.nextCursor ?? null;
    } catch (error) { errorMessage = friendly(error); }
  }

  async function startScanner() {
    if (scanning) return;
    const scanner = new QrVideoScanner();
    qrScanner = scanner;
    scanning = true; scannerLatched = "";
    await tick();
    if (qrScanner !== scanner || !scanning) return;
    await scanner.start(video, async (value) => {
      if (qrScanner !== scanner || !scanning) return;
      if (!value) scannerLatched = "";
      else if (value !== scannerLatched && !submitting) { scannerLatched = value; qrLink = value; stopScanner(); await resolveQr(value); }
    }, () => {
      if (qrScanner !== scanner) return;
      qrScanner = null; scanning = false;
      errorMessage = "カメラを開けませんでした。受付用QRリンクを貼り付けて確認してください。";
    });
  }

  function stopScanner() {
    scanning = false; scannerLatched = ""; const scanner = qrScanner; qrScanner = null; scanner?.stop();
  }

  function errorStatus(error: unknown) { return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 0; }
  function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : ""; }
  function friendly(error: unknown) {
    const code = errorCode(error) || (error instanceof Error ? error.message : "");
    const messages: Record<string, string> = {
      bad_request: "入力内容を確認してください。入退館する会場を選び直してください。",
      not_found: "参加者、受付用QR、または会場が見つかりません。確認して再読み込みしてください。",
      invalid_qr: "有効な受付用QRではありません。最新のチケットQRを確認してください。",
      venue_required: "担当会場を選択してから、もう一度参加者を確認してください。",
      invalid_venue: "イベント内の会場を選択してください。",
      wrong_venue: "担当会場では操作できません。現在の担当会場を確認してください。",
      wrong_current_venue: "参加者は別の会場に在館中です。現在の会場を選んで退館を記録してください。",
      revision_conflict: "在館状態が別の操作で更新されました。最新状態を確認してください。",
      state_conflict: "現在の状態ではその操作を記録できません。最新状態を確認してください。",
      presence_request_conflict: "同じ操作を別の内容では再利用できません。状態を再読み込みしてください。",
      forbidden: "この会場で入退館を操作する権限がありません。",
    };
    return messages[code] ?? (code && !code.includes(" ") ? `入退館を処理できませんでした（${code}）。` : code || "入退館を処理できませんでした。通信を確認してください。");
  }
</script>

<section class="presence-panel" aria-labelledby="presence-title">
  <h2 id="presence-title">入退館管理</h2>
  <p class="muted">入退館記録は受付済みチケットや申込時の会場割当とは独立しています。会場を移るときは、現在の会場で退館してから新しい会場で入館してください。</p>
  {#if venues.length === 0}<p class="muted">入退館にはイベント内の会場が必要です。会場を設定するか、担当会場の読み込みを確認してください。</p>{/if}

  <div class="presence-summary" aria-label="現在の在館状況">
    <div><strong>{summary.total_in}</strong><span>現在在館中</span></div>
    <div><strong>{summary.total_out}</strong><span>未入館・退館中</span></div>
    <div><strong>{summary.total_attendees}</strong><span>参加者数</span></div>
    <div><strong>{summary.total_entries ?? 0}</strong><span>{role === "staff" ? "延べ入館（担当会場全体）" : "延べ入館（イベント全体）"}</span></div>
  </div>
  {#if venueCounts.length}<ul class="presence-venue-counts" aria-label="会場ごとの在館人数">{#each venueCounts as count (count.venue_id)}<li><span>{count.venue_name}</span><strong>{count.count} 人在館中</strong></li>{/each}</ul>{/if}

  <form class="presence-search" onsubmit={(event) => { event.preventDefault(); void searchPeople(); }}>
    <label>名簿から参加者を検索<input bind:value={query} placeholder="氏名または所属" disabled={Boolean(pendingPayload)} /></label>
    {#if venues.length}<label>会場で絞り込む<select bind:value={venueFilter} disabled={Boolean(pendingPayload)} onchange={() => { if (role === "staff") { selectedVenueId = venueFilter; void loadPresence(); } }}>
      {#if role !== "staff"}<option value="">すべての会場・状態</option>{/if}{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}
    </select></label>{/if}
    <button class="quiet" disabled={Boolean(pendingPayload)}>参加者を検索</button>
  </form>
  {#if loading}<p role="status">入退館状態を読み込んでいます…</p>{/if}
  {#if filteredRows.length}
    <div class="presence-results" aria-label="検索結果">
      {#each filteredRows as person (person.attendee_id)}
        <button type="button" class:presence-selected={selectedPerson?.attendee_id === person.attendee_id} class="presence-person-button" aria-pressed={selectedPerson?.attendee_id === person.attendee_id} disabled={Boolean(pendingPayload)} onclick={() => void selectPerson(person)}>
          <strong>{person.name}</strong><span>{person.state === "in" ? `在館中 · ${venues.find((venue) => venue.id === person.venue_id)?.name ?? "会場不明"}` : "退館中"}</span>
        </button>
      {/each}
    </div>
  {:else if !loading && appliedQuery}<p class="muted">該当する参加者がいません。</p>{/if}
  {#if nextCursor}<button type="button" class="quiet" disabled={Boolean(pendingPayload)} onclick={() => void loadPresence(appliedQuery, true)}>参加者をさらに表示</button>{/if}

  {#if canChange}
    <details class="presence-qr">
      <summary>QRから参加者を確認</summary>
      <p class="muted">入退館専用スキャンです。受付処理は実行しません。</p>
      {#if venues.length}<label>入退館会場<select bind:value={selectedVenueId} disabled={Boolean(pendingPayload)}><option value="">会場を選択</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{/if}
      <button type="button" class="quiet" disabled={submitting || Boolean(pendingPayload) || !selectedVenueId} onclick={scanning ? stopScanner : startScanner}>{scanning ? "カメラを閉じる" : "入退館用カメラを開く"}</button>
      {#if scanning}<video bind:this={video} playsinline muted aria-label="入退館用QR読み取りカメラ"></video>{/if}
      <form onsubmit={(event) => { event.preventDefault(); void resolveQr(); }}>
        <label>入退館用QRリンク<input bind:value={qrLink} type="url" inputmode="url" placeholder="https://…/public/tickets/…/check-in/…" required disabled={Boolean(pendingPayload)} /></label>
        <button type="submit" class="quiet" disabled={submitting || Boolean(pendingPayload) || !selectedVenueId}>参加者を確認</button>
      </form>
    </details>
  {/if}

  {#if selectedPerson}
    <section class="presence-selected-card" aria-labelledby="selected-presence-title">
      <h3 id="selected-presence-title">参加者の現在状態</h3>
      <strong>{selectedPerson.name}</strong>
      {#if selectedPerson.affiliation}<span>{selectedPerson.affiliation}</span>{/if}
      <dl>
        <div><dt>在館状態</dt><dd>{selectedPerson.state === "in" ? "在館中" : selectedPerson.revision === 0 ? "未入館（記録なし）" : "退館中"}</dd></div>
        {#if selectedPerson.state === "in"}<div><dt>現在の会場</dt><dd>{personVenueName || "会場不明"}</dd></div>{/if}
        {#if assignedVenueName}<div><dt>申込時の会場割当</dt><dd>{assignedVenueName}</dd></div>{/if}
        {#if selectedPerson.updated_at}<div><dt>状態更新</dt><dd>{formatUtcTimestamp(selectedPerson.updated_at)}</dd></div>{/if}
      </dl>
      {#if canChange}
        {#if selectedPerson.state === "out"}
          {#if venues.length}<label>入退館会場<select bind:value={selectedVenueId} disabled={Boolean(pendingPayload)}><option value="">会場を選択</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{/if}
          <button class="presence-action" disabled={submitting || Boolean(pendingPayload) || !selectedVenueId} onclick={() => beginMovement("enter")}>入館を記録</button>
        {:else}
          <p class="muted">現在の会場から退館してから、別の会場で入館できます。</p>
          <button class="presence-action" disabled={submitting || Boolean(pendingPayload) || !selectedPerson.venue_id} onclick={() => beginMovement("exit")}>{personVenueName || "現在の会場"}から退館を記録</button>
        {/if}
      {/if}
      {#if pendingPayload}<button type="button" class="quiet" disabled={submitting} onclick={() => void retryUnknown()}>前回の入退館記録を再確認</button>{/if}
    </section>

    <section class="presence-history" aria-labelledby="presence-history-title">
      <h3 id="presence-history-title">入退館履歴</h3>
      {#if history.length === 0}<p class="muted">入退館の記録はありません。</p>{:else}<ol>{#each history as movement (movement.id)}<li><strong class:history-unsuccessful={movement.status === "unsuccessful"}>{movement.status === "unsuccessful" ? `${movement.action === "enter" ? "入館" : "退館"}は未記録` : movement.action === "enter" ? "入館" : "退館"}</strong>{#if movement.status === "unsuccessful"}<span>状態が更新されていたため、在館状態は変更されていません。</span>{:else}<span>{movement.venue_name ?? venues.find((venue) => venue.id === movement.venue_id)?.name ?? "会場不明"}</span>{/if}<small>{movement.status === "unsuccessful" ? "確認時刻" : "記録時刻"}: {formatUtcTimestamp(movement.recorded_at)}</small>{#if movement.occurred_at && formatUtcTimestamp(movement.occurred_at) !== formatUtcTimestamp(movement.recorded_at)}<small>申告時刻: {formatUtcTimestamp(movement.occurred_at)}</small>{/if}</li>{/each}</ol>{/if}
      {#if historyCursor}<button type="button" class="quiet" onclick={() => void loadHistory(true)}>履歴をさらに表示</button>{/if}
    </section>
  {/if}

  {#if statusMessage}<p class="presence-status" role="status" aria-live="polite">{statusMessage}</p>{/if}
  {#if errorMessage}<p class="presence-error" role="alert">{errorMessage}</p>{/if}
</section>

<style>
  .presence-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
  .presence-summary div { display: grid; gap: 4px; border-radius: 8px; background: #f1f5f3; padding: 12px; text-align: center; }
  .presence-summary strong { font-size: 1.6rem; color: #14544f; }
  .presence-summary span, .presence-venue-counts { color: #52606d; font-size: .86rem; }
  .presence-venue-counts { padding: 0; list-style: none; }
  .presence-venue-counts li { display: flex; justify-content: space-between; border-top: 1px solid #e5e7eb; padding: 8px 0; }
  .presence-search { display: grid; grid-template-columns: 2fr 1fr auto; align-items: end; gap: 8px; }
  .presence-results { display: grid; gap: 6px; margin: 10px 0; max-height: 300px; overflow: auto; }
  .presence-person-button { display: flex; justify-content: space-between; gap: 10px; width: 100%; text-align: left; color: #1f2933; background: #f7f7f2; border: 1px solid #d8ddd8; }
  .presence-person-button span { color: #52606d; font-size: .85rem; }
  .presence-person-button.presence-selected { border-color: #0f766e; background: #e8f2ef; }
  .presence-qr { margin: 14px 0; border: 1px solid #d8ddd8; border-radius: 8px; padding: 10px; }
  .presence-qr summary { cursor: pointer; font-weight: 700; }
  .presence-qr video { display: block; width: 100%; max-height: 40vh; object-fit: cover; border-radius: 8px; }
  .presence-selected-card, .presence-history { border: 1px solid #d8ddd8; border-radius: 10px; padding: 14px; margin: 12px 0; }
  .presence-selected-card > strong, .presence-selected-card > span { display: block; margin: 4px 0; }
  .presence-selected-card > span { color: #52606d; font-size: .9rem; }
  .presence-selected-card dl > div { display: grid; grid-template-columns: 1fr 2fr; gap: 8px; border-top: 1px solid #e5e7eb; padding: 7px 0; }
  .presence-selected-card dt { color: #52606d; }
  .presence-selected-card dd { margin: 0; }
  .presence-action { width: 100%; min-height: 54px; margin-top: 8px; }
  .presence-history ol { list-style: none; padding: 0; }
  .presence-history li { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; border-top: 1px solid #e5e7eb; padding: 9px 0; }
  .presence-history small { color: #52606d; }
  .history-unsuccessful { color: #8a1c13; }
  .presence-status, .presence-error { padding: 12px; border-radius: 8px; background: #e8f2ef; }
  .presence-error { background: #fff1f0; color: #8a1c13; }
  @media (max-width: 560px) { .presence-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .presence-search { grid-template-columns: 1fr; } .presence-history li { grid-template-columns: 1fr; } }
</style>
