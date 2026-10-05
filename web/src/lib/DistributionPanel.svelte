<script lang="ts">
  import { formatUtcTimestamp } from "./time";
  import { onDestroy, onMount, tick } from "svelte";

  type Api = (path: string, init?: RequestInit) => Promise<any>;
  type Venue = { id: string; name: string };
  type Attendee = { id: string; name: string; affiliation?: string | null; venue_id?: string | null; ticket_status?: string };
  type Distribution = { id: string; name: string; unit: string; max_per_attendee: number; active: boolean | number; created_at: string };
  type Claim = { id: string; request_id: string; quantity: number; attendee_id: string; attendee_name: string; affiliation?: string | null; venue_id?: string | null; venue_name?: string | null; status: "accepted" | "limit_reached" | "reversed"; used_now?: number; remaining_now?: number; created_at: string; reversed_at?: string | null; reverse_reason?: string | null };
  type Person = { attendee_id: string; name: string; affiliation?: string | null; venue_id?: string | null; venue_name?: string | null };
  type ClaimPayload = { requestId: string; attendeeId?: string; qrLink?: string; quantity: number; venueId?: string };

  export let eventId: string;
  export let role: string;
  export let venues: Venue[] = [];
  export let attendees: Attendee[] = [];
  export let api: Api;

  $: isAdmin = role === "owner" || role === "admin";
  $: canClaim = role !== "viewer";
  let distributions: Distribution[] = [];
  let selectedDistributionId = "";
  let claims: Claim[] = [];
  let nextCursor: string | null = null;
  let rosterSearch = "";
  let selectedAttendeeId = "";
  let qrLink = "";
  let selectedPerson: Person | null = null;
  let quantity = 1;
  let selectedVenueId = "";
  let selectedByQr = false;
  let newName = "";
  let newUnit = "個";
  let newLimit = 1;
  let loading = false;
  let submitting = false;
  let scanning = false;
  let scanLatched = "";
  let video: HTMLVideoElement;
  let stream: MediaStream | null = null;
  let statusMessage = "";
  let errorMessage = "";
  let pendingRetry: ClaimPayload | null = null;
  let pendingDistributionId = "";
  let reverseTarget: Claim | null = null;
  let reverseReason = "";

  $: activeDistributions = distributions.filter((round) => Boolean(round.active));
  $: filteredAttendees = attendees.filter((person) => person.ticket_status !== "cancelled" &&
    (!rosterSearch || `${person.name} ${person.affiliation ?? ""}`.toLocaleLowerCase().includes(rosterSearch.toLocaleLowerCase())));
  $: selectedDistribution = distributions.find((round) => round.id === selectedDistributionId) ?? null;

  onMount(() => { void loadDistributions(); });
  onDestroy(stopScanner);

  async function loadDistributions() {
    loading = true; errorMessage = "";
    try {
      const result = await api(`/events/${eventId}/distributions`);
      const rows: Distribution[] = result.distributions ?? [];
      distributions = rows;
      if (!rows.some((round) => round.id === selectedDistributionId)) selectedDistributionId = rows.find((round) => Boolean(round.active))?.id ?? "";
      if (selectedDistributionId) await loadClaims(false);
    } catch (error) { errorMessage = friendly(error); }
    finally { loading = false; }
  }

  async function loadClaims(append = false) {
    if (!selectedDistributionId) { claims = []; nextCursor = null; return; }
    errorMessage = "";
    try {
      const distributionId = selectedDistributionId;
      const params = new URLSearchParams({ limit: "50" });
      if (append && nextCursor) params.set("after", nextCursor);
      const result = await api(`/events/${eventId}/distributions/${distributionId}/claims?${params}`);
      if (selectedDistributionId !== distributionId) return;
      claims = append ? [...claims, ...(result.claims ?? [])] : (result.claims ?? []);
      nextCursor = result.nextCursor ?? null;
    } catch (error) { errorMessage = friendly(error); }
  }

  async function createDistribution() {
    if (!newName.trim() || !newUnit.trim() || !Number.isInteger(newLimit) || newLimit < 1 || newLimit > 1000) return;
    submitting = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/distributions`, { method: "POST", body: JSON.stringify({ name: newName.trim(), unit: newUnit.trim(), maxPerAttendee: newLimit }) });
      newName = ""; newUnit = "個"; newLimit = 1;
      statusMessage = "配布回を作成しました。";
      await loadDistributions();
    } catch (error) { errorMessage = friendly(error); }
    finally { submitting = false; }
  }

  async function setActive(round: Distribution) {
    submitting = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/distributions/${round.id}`, { method: "PATCH", body: JSON.stringify({ active: !round.active }) });
      statusMessage = !round.active ? "配布回を開始しました。" : "配布回を停止しました。";
      await loadDistributions();
    } catch (error) { errorMessage = friendly(error); }
    finally { submitting = false; }
  }

  function selectAttendee(attendeeId: string) {
    selectedAttendeeId = attendeeId;
    const attendee = attendees.find((item) => item.id === attendeeId);
    selectedPerson = attendee ? { attendee_id: attendee.id, name: attendee.name, affiliation: attendee.affiliation, venue_id: attendee.venue_id } : null;
    selectedByQr = false;
    qrLink = "";
  }

  async function resolveQr(value = qrLink) {
    if (!value.trim() || submitting) return;
    submitting = true; errorMessage = ""; selectedPerson = null;
    try {
      const person = await api(`/events/${eventId}/credentials/resolve`, { method: "POST", body: JSON.stringify({ qrLink: value.trim(), venueId: selectedVenueId || undefined }) });
      selectedPerson = { attendee_id: person.attendee_id, name: person.name, affiliation: person.affiliation, venue_id: person.venue_id, venue_name: person.venue_name };
      selectedAttendeeId = person.attendee_id;
      selectedByQr = true;
      statusMessage = "本人を確認しました。配布内容を確認して確定してください。";
    } catch (error) { errorMessage = friendly(error); }
    finally { submitting = false; }
  }

  async function confirmClaim(payload = pendingRetry) {
    if (!payload || submitting || !pendingDistributionId) return;
    submitting = true; errorMessage = ""; statusMessage = "受け渡しを記録しています…";
    try {
      const result = await api(`/events/${eventId}/distributions/${pendingDistributionId}/claims`, { method: "POST", body: JSON.stringify(payload) });
      await finishClaim(result, payload);
    } catch (error) {
      errorMessage = friendly(error);
      const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status >= 400 && status < 500 && status !== 429) {
        pendingRetry = null; pendingDistributionId = "";
        statusMessage = "内容を確認して修正してください。受け渡しは記録されていません。";
      }
      else if (payload === pendingRetry) statusMessage = "応答を確認できませんでした。前回の受け渡しを再確認してください。再送しても二重記録されません。";
      else pendingRetry = payload;
    } finally { submitting = false; }
  }

  async function startRetry() {
    const payload = pendingRetry;
    const distributionId = pendingDistributionId;
    if (!payload || !distributionId || submitting) return;
    submitting = true; errorMessage = ""; statusMessage = "前回の受け渡しを確認しています…";
    try {
      const result = await api(`/events/${eventId}/distributions/${distributionId}/claims/by-request/${payload.requestId}`);
      const claim = result.claim;
      await finishClaim({ outcome: claim.outcome, used: claim.used, remaining: claim.remaining, claim }, payload);
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 404) {
        submitting = false;
        await confirmClaim(payload);
        return;
      }
      errorMessage = friendly(error);
      statusMessage = "前回の結果を確認できませんでした。通信を確認してから、もう一度確認してください。";
    } finally { submitting = false; }
  }

  async function finishClaim(result: any, payload: ClaimPayload) {
    pendingRetry = null;
    pendingDistributionId = "";
    const unit = selectedDistribution?.unit ?? "個";
    const maximum = selectedDistribution?.max_per_attendee ?? "?";
    if (result.outcome === "limit_reached") {
      statusMessage = `この方は上限に達しています（${result.used ?? maximum}/${maximum} ${unit}使用）。数量を調整してください。`;
    } else {
      statusMessage = `${selectedPerson?.name ?? "参加者"}の受け渡しを記録しました。今回 ${result.claim?.quantity ?? payload.quantity}${unit}、この配布回で使用済み ${result.used}/${maximum}、残り ${result.remaining}${unit}。再送しても二重記録されません。`;
      quantity = 1;
    }
    await loadClaims(false);
  }

  async function submitClaim() {
    if (!selectedDistribution || !selectedDistribution.active || !selectedPerson || pendingRetry || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return;
    pendingDistributionId = selectedDistribution.id;
    pendingRetry = {
      requestId: crypto.randomUUID(), ...(selectedByQr && qrLink ? { qrLink: qrLink.trim() } : { attendeeId: selectedPerson.attendee_id }), quantity,
      ...(selectedVenueId ? { venueId: selectedVenueId } : selectedPerson.venue_id ? { venueId: selectedPerson.venue_id } : {}),
    };
    await confirmClaim(pendingRetry);
  }

  async function reverseClaim(claim: Claim) {
    if (!reverseReason.trim() || submitting) return;
    submitting = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/distributions/${selectedDistributionId}/claims/${claim.id}/reverse`, { method: "POST", body: JSON.stringify({ reason: reverseReason.trim() }) });
      statusMessage = "配布記録を取り消し、残数を戻しました。"; reverseTarget = null; reverseReason = ""; await loadClaims(false);
    } catch (error) { errorMessage = friendly(error); }
    finally { submitting = false; }
  }

  async function startScanner() {
    const browser = window as Window & { BarcodeDetector?: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } };
    if (!browser.BarcodeDetector) { statusMessage = "このブラウザーはカメラ読取に対応していません。チケットの受付QRリンクを下へ貼り付けてください。"; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      scanning = true; await tick(); video.srcObject = stream; await video.play();
      const detector = new browser.BarcodeDetector({ formats: ["qr_code"] });
      const scan = async () => {
        if (!scanning) return;
        try {
          const value = (await detector.detect(video))[0]?.rawValue ?? "";
          if (!value) scanLatched = "";
          else if (value !== scanLatched && !submitting) { scanLatched = value; qrLink = value; await resolveQr(value); }
        } catch { /* Continue scanning; the pasted link remains available. */ }
        if (scanning) requestAnimationFrame(() => void scan());
      };
      void scan();
    } catch { stopScanner(); statusMessage = "カメラを開けませんでした。チケットの受付QRリンクを貼り付けてください。"; }
  }

  function stopScanner() {
    scanning = false; scanLatched = ""; stream?.getTracks().forEach((track) => track.stop()); stream = null;
    if (video) video.srcObject = null;
  }

  function friendly(error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      bad_request: "入力内容を確認してください。数量や選択内容を見直してください。",
      not_found: "対象が見つかりません。イベント、配布回、参加者を確認してください。",
      distribution_not_found: "配布回が見つかりません。再読み込みしてください。",
      distribution_name_exists: "同じ名前の配布回がすでにあります。別の名前を入力してください。",
      distribution_inactive: "この配布回は停止中です。管理者に確認してください。",
      attendee_not_found: "参加者が見つかりません。名簿を再読み込みしてください。",
      invalid_qr: "有効な受付用QRではありません。参加者のチケットQRを確認してください。",
      limit_reached: "この方はこの配布回の上限に達しています。",
      idempotency_conflict: "同じ要求IDで異なる内容が送られました。画面を再読み込みしてください。",
      claim_already_reversed: "この配布記録はすでに取り消されています。履歴を再読み込みしてください。",
      venue_required: "未割当の参加者です。配布会場を選択してから、もう一度確認してください。",
      wrong_venue: "参加者の会場と選択した会場が一致しません。",
      invalid_venue: "このイベントの会場を選択してください。",
      claim_not_reversible: "この配布記録は取り消せません。履歴を再読み込みしてください。",
      forbidden: "この操作を行う権限がありません。",
    };
    return messages[code] ?? (code && !code.includes(" ") ? `処理できませんでした（${code}）。` : code || "処理できませんでした。ネットワークを確認してください。");
  }
</script>

<section class="distribution-panel" aria-labelledby="distribution-title">
  <h2 id="distribution-title">配布管理</h2>
  <p class="muted">配布回ごとに受け渡しと上限を記録します。受付済みチケットのQRも利用できます。配布は受付とは別に記録されます。</p>

  {#if isAdmin}
    <form class="distribution-create" onsubmit={(event) => { event.preventDefault(); void createDistribution(); }}>
      <label>配布するもの<input bind:value={newName} maxlength="100" required placeholder="例: 昼食" /></label>
      <label>単位<input bind:value={newUnit} maxlength="20" required placeholder="個、枚など" /></label>
      <label>1人あたり上限<input bind:value={newLimit} type="number" min="1" max="1000" step="1" required /></label>
      <button disabled={submitting}>配布回を作成</button>
    </form>
  {/if}

  {#if loading}<p role="status">配布回を読み込んでいます…</p>{/if}
  {#if distributions.length}
    <div class="distribution-rounds" aria-label="配布回一覧">
      {#each distributions as round (round.id)}
        <div class:round-selected={selectedDistributionId === round.id} class="distribution-round">
          <button type="button" class="round-select" disabled={Boolean(pendingRetry)} aria-pressed={selectedDistributionId === round.id} onclick={() => { selectedDistributionId = round.id; statusMessage = ""; void loadClaims(false); }}>
            <strong>{round.name}</strong><span>{round.active ? "配布中" : "停止中"} · 上限 {round.max_per_attendee} {round.unit}/人</span>
          </button>
          {#if isAdmin}<button type="button" class="quiet" disabled={submitting} onclick={() => void setActive(round)}>{round.active ? "停止" : "開始"}</button>{/if}
        </div>
      {/each}
    </div>
  {:else if !loading}<p>配布回はまだありません。</p>{/if}

  {#if selectedDistribution}
    <div class="distribution-current">
      <h3>{selectedDistribution.name} を配布</h3>
      <p class="muted">受け渡し前に参加者と数量を確認してください。1人あたり上限はこの配布回にのみ適用されます。</p>
      {#if canClaim && selectedDistribution.active}
        <label>名簿から参加者を検索<input bind:value={rosterSearch} autocomplete="off" placeholder="氏名または所属" disabled={Boolean(pendingRetry)} /></label>
        <label>参加者<select value={selectedAttendeeId} disabled={Boolean(pendingRetry)} onchange={(event) => selectAttendee(event.currentTarget.value)}>
          <option value="">参加者を選択</option>
          {#each filteredAttendees as attendee (attendee.id)}<option value={attendee.id}>{attendee.name}{attendee.affiliation ? ` · ${attendee.affiliation}` : ""}</option>{/each}
        </select></label>
        {#if venues.length}<label>受け渡し会場<select bind:value={selectedVenueId} disabled={Boolean(pendingRetry)}><option value="">参加者の会場割当を使用</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{/if}
        <details class="distribution-qr">
          <summary>チケットQRから参加者を確認</summary>
          <p class="muted">配布専用スキャンです。受付処理は実行しません。会場割当がある参加者はその会場を使い、未割当の場合は確認前に配布会場を選択してください。</p>
          <button type="button" class="quiet" disabled={submitting} onclick={scanning ? stopScanner : startScanner}>{scanning ? "カメラを閉じる" : "配布用カメラを開く"}</button>
          {#if scanning}<video bind:this={video} playsinline aria-label="配布用QR読み取りカメラ"></video>{/if}
          <form onsubmit={(event) => { event.preventDefault(); void resolveQr(); }}>
            <label>チケットの受付QRリンク<input bind:value={qrLink} type="url" inputmode="url" placeholder="https://…/public/tickets/…/check-in/…" required disabled={Boolean(pendingRetry)} /></label>
            <button type="submit" class="quiet" disabled={submitting}>参加者を確認</button>
          </form>
        </details>
        {#if selectedPerson}
          <div class="distribution-person" aria-live="polite"><strong>確認する参加者: {selectedPerson.name}</strong>{#if selectedPerson.affiliation}<span>{selectedPerson.affiliation}</span>{/if}{#if selectedPerson.venue_name}<span>会場: {selectedPerson.venue_name}</span>{/if}</div>
          <label>数量<input bind:value={quantity} type="number" min="1" max="1000" step="1" inputmode="numeric" disabled={Boolean(pendingRetry)} /></label>
          <button class="distribution-confirm" disabled={submitting || Boolean(pendingRetry) || !Number.isInteger(quantity) || quantity < 1 || (role === "staff" && venues.length > 0 && !selectedVenueId && !selectedPerson.venue_id)} onclick={() => void submitClaim()}>
            {submitting ? "記録しています…" : `${selectedPerson.name} に ${quantity} ${selectedDistribution.unit} 渡したことを記録`}
          </button>
        {/if}
        {#if pendingRetry}<button type="button" class="quiet" disabled={submitting} onclick={startRetry}>前回の記録を再確認</button>{/if}
      {:else if canClaim}<p class="notice">この配布回は停止中です。</p>{/if}
    </div>

    <div class="distribution-history">
      <h3>受け渡し履歴</h3>
      {#if claims.length === 0}<p class="muted">記録はありません。</p>{:else}
        <div class="distribution-claim-list">
          {#each claims as claim (claim.id)}
            <article class:claim-reversed={claim.reversed_at || claim.status === "reversed"} class="distribution-claim">
              <div>
                {#if claim.status === "limit_reached"}
                  <strong>上限超過・未配布</strong><span>{claim.attendee_name} · 試行数量 {claim.quantity} {selectedDistribution.unit}</span>
                {:else if claim.status === "reversed" || claim.reversed_at}
                  <strong>{claim.attendee_name} · 取消済み</strong><span>取消数量 {claim.quantity} {selectedDistribution.unit}</span>
                {:else}
                  <strong>{claim.attendee_name}</strong><span>配布数量 {claim.quantity} {selectedDistribution.unit}</span>
                {/if}
                <small>{claim.affiliation ?? "所属未登録"}{claim.venue_name ? ` · ${claim.venue_name}` : ""} · {formatUtcTimestamp(claim.created_at)}</small>
                {#if claim.status === "accepted" && !claim.reversed_at && claim.used_now !== undefined}<small>この配布回: 使用 {claim.used_now}/{selectedDistribution.max_per_attendee}、残り {claim.remaining_now ?? Math.max(0, selectedDistribution.max_per_attendee - claim.used_now)} {selectedDistribution.unit}</small>{/if}
                {#if (claim.status === "reversed" || claim.reversed_at) && claim.reverse_reason}<small>取消理由: {claim.reverse_reason}</small>{/if}
              </div>
              {#if isAdmin && claim.status === "accepted" && !claim.reversed_at}<button type="button" class="quiet" disabled={submitting} onclick={() => { reverseTarget = claim; reverseReason = ""; }}>取消</button>{/if}
            </article>
          {/each}
        </div>
        {#if nextCursor}<button type="button" class="quiet" onclick={() => void loadClaims(true)}>履歴をさらに表示</button>{/if}
      {/if}
    </div>
  {/if}

  {#if statusMessage}<p class="distribution-status" role="status" aria-live="polite">{statusMessage}</p>{/if}
  {#if errorMessage}<p class="distribution-error" role="alert">{errorMessage}</p>{/if}

  {#if reverseTarget}<div class="dialog-backdrop"><dialog open class="confirm-dialog" aria-modal="true" aria-labelledby="reverse-claim-title">
    <h2 id="reverse-claim-title">配布記録を取り消す</h2><p>{reverseTarget.attendee_name} · {reverseTarget.quantity} {selectedDistribution?.unit ?? "個"}</p>
    <form onsubmit={(event) => { event.preventDefault(); void reverseClaim(reverseTarget!); }}><label>取消理由<textarea bind:value={reverseReason} maxlength="500" required></textarea></label><button disabled={submitting || !reverseReason.trim()}>理由を記録して取消</button><button type="button" class="quiet" onclick={() => reverseTarget = null}>戻る</button></form>
  </dialog></div>{/if}
</section>

<style>
  .distribution-create { display: grid; grid-template-columns: 1.5fr 1fr 1fr auto; gap: 8px; align-items: end; }
  .distribution-create label { min-width: 0; }
  .distribution-rounds, .distribution-claim-list { display: grid; gap: 8px; margin: 12px 0; }
  .distribution-round, .distribution-claim { display: flex; justify-content: space-between; align-items: center; gap: 10px; border: 1px solid #d8ddd8; border-radius: 9px; padding: 10px; }
  .distribution-round.round-selected { border-color: #0f766e; background: #e8f2ef; }
  .round-select { display: grid; gap: 4px; background: transparent; color: #1f2933; text-align: left; padding: 6px; flex: 1; }
  .round-select:hover { background: transparent; color: #14544f; }
  .round-select span, .distribution-claim small, .distribution-claim span, .distribution-person span { display: block; color: #52606d; font-size: .82rem; }
  .distribution-current, .distribution-history { border-top: 1px solid #e5e7eb; margin-top: 18px; padding-top: 12px; }
  .distribution-qr { margin: 12px 0; border: 1px solid #d8ddd8; border-radius: 8px; padding: 10px; }
  .distribution-qr summary { cursor: pointer; font-weight: 700; }
  .distribution-qr video { display: block; width: 100%; max-height: 40vh; object-fit: cover; border-radius: 8px; }
  .distribution-person { display: grid; gap: 4px; border-left: 4px solid #0f766e; background: #e8f2ef; border-radius: 7px; padding: 12px; margin: 12px 0; }
  .distribution-confirm { width: 100%; min-height: 54px; margin: 8px 0; }
  .distribution-claim > div { min-width: 0; }
  .distribution-claim small { overflow-wrap: anywhere; margin-top: 4px; }
  .claim-reversed { opacity: .65; }
  .distribution-status, .distribution-error { padding: 12px; border-radius: 8px; background: #e8f2ef; }
  .distribution-error { background: #fff1f0; color: #8a1c13; }
  @media (max-width: 560px) {
    .distribution-create { grid-template-columns: 1fr; }
    .distribution-round, .distribution-claim { align-items: flex-start; }
    .round-select { padding-left: 0; }
  }
</style>
