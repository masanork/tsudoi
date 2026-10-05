<script lang="ts">
  import { onMount } from "svelte";
  import { formatUtcTimestamp } from "./time";

  type Api = (path: string, init?: RequestInit) => Promise<any>;
  type Venue = { id: string; name: string };
  type Attendee = { id: string; name: string; affiliation?: string | null; venue_id?: string | null; ticket_status: string };
  type HouseholdSummary = { id: string; name: string; member_count: number };
  type Member = { attendeeId: string; name: string; affiliation?: string | null; venueId?: string | null; ticketStatus: string; used: number | null; remaining: number | null };
  type Distribution = { id: string; name: string; unit: string; max_per_attendee: number; active: boolean | number };
  type ProxyItem = { claimId?: string | null; attendeeId: string; attendeeName: string; quantity: number; status?: string; used?: number; remaining?: number };
  type ProxyClaim = { id: string; request_id: string; household_id: string; household_name: string; collector_id: string; collector_name: string; venue_id?: string | null; outcome: "accepted" | "limit_reached"; created_at: string; reversed_at?: string | null; items: ProxyItem[] };
  type ProxyPayload = { requestId: string; householdId: string; collectorId: string; items: Array<{ attendeeId: string; quantity: number }>; venueId: string };

  export let eventId: string;
  export let role: string;
  export let venues: Venue[] = [];
  export let attendees: Attendee[] = [];
  export let api: Api;

  $: isAdmin = role === "owner" || role === "admin";
  $: canReceive = role !== "viewer";
  $: availableAttendees = attendees.filter((person) => ["issued", "checked_in"].includes(person.ticket_status));
  $: selectedHousehold = households.find((item) => item.id === householdId) ?? null;
  $: selectedDistribution = distributions.find((item) => item.id === distributionId) ?? null;
  $: selectedVenueName = venues.find((venue) => venue.id === venueId)?.name ?? "";
  let households: HouseholdSummary[] = [];
  let householdId = "";
  let householdName = "";
  let household: { id: string; name: string; members: Member[] } | null = null;
  let newMemberId = "";
  let distributions: Distribution[] = [];
  let distributionId = "";
  let venueId = "";
  let collectorId = "";
  let selectedForProxy: Record<string, boolean> = {};
  let quantities: Record<string, number> = {};
  let history: ProxyClaim[] = [];
  let historyCursor: string | null = null;
  let pending: { payload: ProxyPayload; distributionId: string } | null = null;
  let busy = false;
  let errorMessage = "";
  let statusMessage = "";
  let reverseReason = "";
  let historyRequestSequence = 0;

  $: chosenMemberCount = Object.values(selectedForProxy).filter(Boolean).length;
  $: selectedItems = household?.members.filter((member) => selectedForProxy[member.attendeeId]) ?? [];
  $: canSubmitProxy = Boolean(selectedHousehold && household && collectorId && selectedDistribution && Boolean(selectedDistribution.active) && venueId && selectedItems.length > 0 && selectedItems.length <= 20
    && selectedItems.every((member) => Number.isInteger(quantities[member.attendeeId]) && quantities[member.attendeeId] >= 1
      && member.remaining !== null && quantities[member.attendeeId] <= (member.remaining ?? 0)));
  $: if (role === "staff" && venues.length && !venueId) venueId = venues[0].id;

  $: if (householdId) void loadHousehold();
  $: if (distributionId) void loadHistory(false);
  $: if (role === "staff" && venueId) void loadHouseholds();

  onMount(() => { void loadInitial(); });

  async function loadInitial() {
    await Promise.all([role === "staff" ? Promise.resolve() : loadHouseholds(), loadDistributions()]);
  }
  async function loadHouseholds() {
    const requestEvent = eventId, requestVenue = venueId;
    try {
      const params = new URLSearchParams();
      if (requestVenue) params.set("venueId", requestVenue);
      const result = await api(`/events/${requestEvent}/households${params.size ? `?${params}` : ""}`);
      if (eventId !== requestEvent || (role === "staff" && venueId !== requestVenue)) return;
      households = result.households ?? [];
      if (!households.some((item) => item.id === householdId)) householdId = households[0]?.id ?? "";
      if (!households.length) household = null;
    } catch (error) { if (eventId === requestEvent && (role !== "staff" || venueId === requestVenue)) errorMessage = friendly(error); }
  }
  async function loadDistributions() {
    try {
      const result = await api(`/events/${eventId}/distributions`);
      distributions = result.distributions ?? [];
      if (!distributions.some((item: Distribution) => item.id === distributionId)) distributionId = distributions.find((item: Distribution) => Boolean(item.active))?.id ?? "";
    } catch (error) { errorMessage = friendly(error); }
  }
  async function loadHousehold() {
    if (!householdId) { household = null; return; }
    const currentHouseholdId = householdId, currentVenueId = venueId, currentDistributionId = distributionId, requestEvent = eventId;
    try {
      const params = new URLSearchParams();
      if (venueId) params.set("venueId", venueId);
      if (distributionId) params.set("distributionId", distributionId);
      const suffix = params.size ? `?${params}` : "";
      const result = await api(`/events/${requestEvent}/households/${currentHouseholdId}${suffix}`);
      if (eventId !== requestEvent || householdId !== currentHouseholdId || venueId !== currentVenueId || distributionId !== currentDistributionId) return;
      household = result.household ?? null;
      if (household && !household.members.some((member) => member.attendeeId === collectorId)) collectorId = "";
      if (household) {
        selectedForProxy = {};
        quantities = Object.fromEntries(household.members.map((member) => [member.attendeeId, 0]));
      }
    } catch (error) {
      if (eventId === requestEvent && householdId === currentHouseholdId && venueId === currentVenueId && distributionId === currentDistributionId) {
        household = null; selectedForProxy = {}; quantities = {}; errorMessage = friendly(error);
      }
    }
  }
  async function createHousehold() {
    if (!isAdmin || !householdName.trim() || busy) return;
    busy = true; errorMessage = "";
    try {
      const result = await api(`/events/${eventId}/households`, { method: "POST", body: JSON.stringify({ name: householdName.trim() }) });
      const createdId = result.household.id;
      householdName = ""; householdId = createdId; statusMessage = "世帯を作成しました。";
      await loadHouseholds(); householdId = createdId; await loadHousehold();
    } catch (error) { errorMessage = friendly(error); }
    finally { busy = false; }
  }
  async function renameHousehold() {
    if (!isAdmin || !household || !household.name.trim() || busy) return;
    busy = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/households/${household.id}`, { method: "PATCH", body: JSON.stringify({ name: household.name.trim() }) });
      statusMessage = "世帯名を更新しました。"; await loadHouseholds();
    } catch (error) { errorMessage = friendly(error); }
    finally { busy = false; }
  }
  async function addMember() {
    if (!isAdmin || !household || !newMemberId || busy || household.members.length >= 50) return;
    busy = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/households/${household.id}/members`, { method: "POST", body: JSON.stringify({ attendeeId: newMemberId }) });
      newMemberId = ""; statusMessage = "世帯メンバーを追加しました。"; await loadHouseholds(); await loadHousehold();
    } catch (error) { errorMessage = friendly(error); }
    finally { busy = false; }
  }
  async function removeMember(member: Member) {
    if (!isAdmin || !household || busy) return;
    busy = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/households/${household.id}/members/${member.attendeeId}`, { method: "DELETE" });
      statusMessage = `${member.name}を世帯から外しました。`; await loadHouseholds(); await loadHousehold();
    } catch (error) { errorMessage = friendly(error); }
    finally { busy = false; }
  }
  function toggleBeneficiary(member: Member, checked: boolean) {
    const selectedCount = chosenMemberCount;
    if (checked && selectedCount >= 20) { errorMessage = "一度に受け取れる対象者は20人までです。"; return; }
    selectedForProxy = { ...selectedForProxy, [member.attendeeId]: checked };
    if (checked && (!Number.isInteger(quantities[member.attendeeId]) || quantities[member.attendeeId] < 1)) quantities = { ...quantities, [member.attendeeId]: 1 };
    errorMessage = "";
  }
  async function submitProxy() {
    if (!canReceive || !canSubmitProxy || pending || busy || !household) return;
    const payload: ProxyPayload = {
      requestId: crypto.randomUUID(), householdId: household.id, collectorId,
      venueId, items: selectedItems.map((member) => ({ attendeeId: member.attendeeId, quantity: quantities[member.attendeeId] })),
    };
    pending = { payload, distributionId };
    await sendProxy(pending);
  }
  async function sendProxy(request: { payload: ProxyPayload; distributionId: string }, retryingUnknown = false) {
    if (busy) return;
    busy = true; errorMessage = ""; statusMessage = "世帯の受取を確認しています…";
    try {
      const result = await api(`/events/${eventId}/distributions/${request.distributionId}/proxy-claims`, { method: "POST", body: JSON.stringify(request.payload) });
      await finishProxy(result);
    } catch (error) {
      const status = errorStatus(error); errorMessage = friendly(error);
      if (retryingUnknown && status >= 400 && status < 500 && status !== 429) {
        statusMessage = "前回の受取結果を確認できません。権限や担当会場が変わった可能性があります。操作を保留して管理者に確認してください。";
      } else if (!retryingUnknown && status >= 400 && status < 500 && status !== 429) {
        pending = null; statusMessage = "受取は成立していません。対象者の数量や残数を確認してください。"; await loadHousehold();
      } else statusMessage = "応答を確認できませんでした。対象者と数量を変えずに受取結果を再確認してください。";
    } finally { busy = false; }
  }
  async function reconcileProxy() {
    const request = pending;
    if (!request || busy) return;
    busy = true; errorMessage = ""; statusMessage = "前回の世帯受取結果を確認しています…";
    try {
      const result = await api(`/events/${eventId}/distributions/${request.distributionId}/proxy-claims/by-request/${request.payload.requestId}`);
      await finishProxy(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) { busy = false; await sendProxy(request, true); return; }
      errorMessage = friendly(error); statusMessage = "前回の結果を確認できませんでした。権限と担当会場を確認してください。";
    } finally { busy = false; }
  }
  async function finishProxy(result: any) {
    const proxyClaim = result.proxyClaim;
    pending = null;
    if (result.outcome === "accepted") {
      statusMessage = `${proxyClaim?.collector_name ?? household?.members.find((member) => member.attendeeId === collectorId)?.name ?? "受取担当"}が世帯の受取を完了しました。対象 ${proxyClaim?.items?.length ?? 0} 人分を一括で記録しました。`;
      selectedForProxy = {};
    } else {
      statusMessage = "世帯受取は上限超過のため成立していません。対象者全員の受取記録は追加されていません。数量と残数を確認してください。";
    }
    await Promise.all([loadHousehold(), loadHistory(false)]);
  }
  async function loadHistory(append = false) {
    const roundId = distributionId, requestHouseholdId = householdId, requestEvent = eventId, requestVenueId = venueId;
    if (!roundId) { historyRequestSequence += 1; history = []; historyCursor = null; return; }
    const requestSequence = ++historyRequestSequence;
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (householdId) params.set("householdId", householdId);
      if (role === "staff" && venueId) params.set("venueId", venueId);
      if (append && historyCursor) params.set("after", historyCursor);
      const result = await api(`/events/${requestEvent}/distributions/${roundId}/proxy-claims?${params}`);
      if (eventId !== requestEvent || distributionId !== roundId || householdId !== requestHouseholdId || venueId !== requestVenueId || requestSequence !== historyRequestSequence) return;
      history = append ? [...history, ...(result.proxyClaims ?? [])] : (result.proxyClaims ?? []);
      historyCursor = result.nextCursor ?? null;
    } catch (error) {
      if (eventId === requestEvent && distributionId === roundId && householdId === requestHouseholdId && venueId === requestVenueId && requestSequence === historyRequestSequence) errorMessage = friendly(error);
    }
  }
  async function reverseProxy(claim: ProxyClaim) {
    if (!isAdmin || !reverseReason.trim() || busy || claim.reversed_at) return;
    busy = true; errorMessage = "";
    try {
      await api(`/events/${eventId}/distributions/${distributionId}/proxy-claims/${claim.id}/reverse`, { method: "POST", body: JSON.stringify({ reason: reverseReason.trim() }) });
      reverseReason = ""; statusMessage = "世帯受取をまとめて取り消しました。";
      await Promise.all([loadHistory(false), loadHousehold()]);
    } catch (error) { errorMessage = friendly(error); }
    finally { busy = false; }
  }
  function errorStatus(error: unknown) { return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 0; }
  function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : ""; }
  function friendly(error: unknown) {
    const code = errorCode(error);
    const messages: Record<string, string> = {
      not_found: "世帯、参加者、配布回、または会場が見つかりません。画面を再読み込みしてください。",
      venue_required: "担当会場を選んでください。",
      venue_not_assigned: "この会場の担当者ではありません。担当会場を確認してください。",
      household_limit: "世帯メンバーは50人までです。",
      attendee_already_in_household: "この参加者はすでに世帯メンバーです。",
      household_member_unavailable: "対象者または受取担当がこの世帯の有効な参加者ではありません。世帯メンバーを確認してください。",
      proxy_beneficiary_limit: "一度の代理受取は20人までです。",
      distribution_inactive: "この配布回は停止中です。",
      mixed_venue: "選択した対象者の会場が異なります。会場を確認して同じ会場の対象者ごとに受け取ってください。",
      proxy_claim_request_conflict: "同じ操作IDに異なる内容が指定されています。管理者に確認してください。",
      proxy_claim_already_reversed: "この世帯受取はすでに取り消されています。",
    };
    return messages[code] ?? "世帯受取を処理できませんでした。数量、会場、権限を確認してください。";
  }
</script>

<section class="household-panel" aria-labelledby="household-panel-title">
  <h2 id="household-panel-title">世帯・代理受取</h2>
  <p class="muted">世帯の受取担当と対象者をそれぞれ選び、対象者ごとの数量を指定します。全員分を一括で記録するため、上限を超えた場合は誰の受取も記録されません。</p>
  {#if isAdmin}
    <form class="household-create" onsubmit={(event) => { event.preventDefault(); void createHousehold(); }}>
      <label>世帯名<input bind:value={householdName} maxlength="120" required disabled={busy || Boolean(pending)} /></label>
      <button disabled={busy || Boolean(pending) || !householdName.trim()}>世帯を作成</button>
    </form>
  {/if}
  <div class="household-controls">
      <label>世帯を選択<select bind:value={householdId} disabled={busy || Boolean(pending)} onchange={() => { household = null; history = []; historyCursor = null; selectedForProxy = {}; quantities = {}; collectorId = ""; void loadHousehold(); void loadHistory(false); }}><option value="">世帯を選択してください</option>{#each households as item}<option value={item.id}>{item.name}（{item.member_count}人）</option>{/each}</select></label>
    {#if venues.length}<label>世帯受取を行う会場<select bind:value={venueId} disabled={Boolean(pending)} onchange={() => { household = null; history = []; historyCursor = null; selectedForProxy = {}; quantities = {}; collectorId = ""; void loadHouseholds(); void loadHousehold(); void loadHistory(false); }}><option value="">会場を選択してください</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{/if}
    {#if distributions.length}<label>配布回<select bind:value={distributionId} disabled={Boolean(pending)} onchange={() => { household = null; history = []; historyCursor = null; selectedForProxy = {}; quantities = {}; void loadHistory(false); void loadHousehold(); }}><option value="">配布回を選択してください</option>{#each distributions as round}<option value={round.id}>{round.name}（{round.unit}・上限{round.max_per_attendee}）</option>{/each}</select></label>{/if}
  </div>
  {#if household}
    <section class="household-members" aria-labelledby="household-members-title">
      <h3 id="household-members-title">世帯メンバー（{household.members.length}/50）</h3>
      {#if isAdmin}<form onsubmit={(event) => { event.preventDefault(); void renameHousehold(); }}><label>世帯名<input bind:value={household.name} maxlength="120" disabled={busy || Boolean(pending)} /></label><button class="quiet" disabled={busy || Boolean(pending) || !household.name.trim()}>世帯名を更新</button></form>{/if}
      {#if isAdmin}
        <form class="add-member" onsubmit={(event) => { event.preventDefault(); void addMember(); }}><label>世帯に追加する参加者<select bind:value={newMemberId} disabled={busy || Boolean(pending) || household.members.length >= 50}><option value="">名簿から選択</option>{#each availableAttendees.filter((person) => !household?.members.some((member) => member.attendeeId === person.id)) as person}<option value={person.id}>{person.name}</option>{/each}</select></label><button disabled={busy || Boolean(pending) || !newMemberId || household.members.length >= 50}>世帯メンバーを追加</button></form>
      {/if}
      {#if household.members.length}<ul class="member-list">{#each household.members as member (member.attendeeId)}<li><div><strong>{member.name}</strong>{#if member.affiliation}<span>{member.affiliation}</span>{/if}{#if distributionId}<span>この配布回: {member.used ?? 0} 使用・残り {member.remaining ?? "—"}</span>{/if}</div>{#if isAdmin}<button type="button" class="quiet" disabled={busy || Boolean(pending)} aria-label={`${member.name}を世帯から外す`} onclick={() => void removeMember(member)}>世帯から外す</button>{/if}</li>{/each}</ul>{:else}<p>世帯メンバーが登録されていません。</p>{/if}
    </section>
  {/if}

  {#if canReceive && household}
    <section class="proxy-form" aria-labelledby="proxy-form-title">
      <h3 id="proxy-form-title">世帯分を受け取る</h3>
      <label>受取担当<select bind:value={collectorId} disabled={Boolean(pending) || busy}><option value="">受取担当を選択してください</option>{#each household.members as member}<option value={member.attendeeId}>{member.name}</option>{/each}</select></label>
      <p class="muted">配布対象者ごとにチェックし、渡した数量を入力してください。選択できる対象者は一度に20人までです。</p>
      {#if !distributionId}<p class="notice">先に配布回を選択してください。</p>{/if}
      {#if distributionId && selectedDistribution && !selectedDistribution.active}<p class="notice">この配布回は停止中です。履歴のみ確認できます。</p>{/if}
      <div class="proxy-beneficiaries">{#each household.members as member (member.attendeeId)}<div class="proxy-member"><label class="proxy-member-select"><input type="checkbox" checked={Boolean(selectedForProxy[member.attendeeId])} disabled={Boolean(pending) || busy || (!selectedForProxy[member.attendeeId] && chosenMemberCount >= 20) || !selectedDistribution || !selectedDistribution.active || member.remaining === null || member.remaining <= 0} onchange={(event) => toggleBeneficiary(member, event.currentTarget.checked)} />{member.name}</label><span>使用 {member.used ?? "—"}・残り {member.remaining ?? "—"}</span><label>数量（{member.name}）<input type="number" min="1" max={member.remaining ?? undefined} step="1" bind:value={quantities[member.attendeeId]} disabled={!selectedForProxy[member.attendeeId] || Boolean(pending) || busy || member.remaining === null} /></label></div>{/each}</div>
      <button class="proxy-submit" disabled={!canSubmitProxy || Boolean(pending) || busy} onclick={() => void submitProxy()}>世帯分を受け取る（{chosenMemberCount}人）</button>
      {#if pending}<p class="pending" role="status">受取結果を確認できていません。対象・数量・担当者を変えずに確認してください。</p><button type="button" class="quiet" disabled={busy} onclick={() => void reconcileProxy()}>受取結果を再確認</button>{/if}
    </section>
  {/if}

  {#if history.length}
    <section class="proxy-history" aria-labelledby="proxy-history-title"><h3 id="proxy-history-title">世帯受取履歴</h3><ol>{#each history as claim (claim.id)}<li><strong>{claim.household_name}・受取担当 {claim.collector_name}{claim.outcome === "limit_reached" ? "・上限超過（未配布）" : ""}</strong><small>{formatUtcTimestamp(claim.created_at)}{#if claim.reversed_at} · 取消済み{/if}</small><ul>{#each claim.items as item (`${claim.id}-${item.attendeeId}`)}<li>{item.attendeeName}: {#if claim.outcome === "limit_reached"}試行数量 {item.quantity}{:else}{item.quantity} 配布（受取時残り {item.remaining ?? "—"}）{/if}</li>{/each}</ul>{#if isAdmin && claim.outcome === "accepted" && !claim.reversed_at}<details><summary>世帯受取をまとめて取り消す</summary><label>取消理由<textarea bind:value={reverseReason} maxlength="500" required disabled={busy}></textarea></label><button type="button" class="danger" disabled={busy || reverseReason.trim().length < 3} onclick={() => void reverseProxy(claim)}>取消を確定</button></details>{/if}</li>{/each}</ol>{#if historyCursor}<button type="button" class="quiet" onclick={() => void loadHistory(true)}>履歴をさらに表示</button>{/if}</section>
  {:else if distributionId}<section class="proxy-history"><h3>世帯受取履歴</h3><p class="muted">この配布回の世帯受取はありません。</p></section>{/if}
  {#if statusMessage}<p role="status" aria-live="polite">{statusMessage}</p>{/if}
  {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
</section>

<style>
  .household-panel, .household-members, .proxy-form, .proxy-history { border: 1px solid #d8ddd8; border-radius: 10px; padding: 14px; margin: 14px 0; }
  .household-create, .household-controls, .add-member { display: grid; grid-template-columns: 2fr 1fr; gap: 9px; align-items: end; }
  .household-controls { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .member-list, .proxy-history ol { list-style: none; padding: 0; }
  .member-list li { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid #e5e7eb; padding: 9px 0; }
  .member-list li div { display: grid; gap: 4px; }
  .member-list span, .proxy-member > span, .proxy-history small { color: #52606d; font-size: .86rem; }
  .proxy-beneficiaries { display: grid; gap: 8px; }
  .proxy-member { display: grid; grid-template-columns: 1fr auto minmax(110px, .45fr); gap: 10px; align-items: center; border-top: 1px solid #e5e7eb; padding: 10px 0; }
  .proxy-member-select { display: flex; align-items: center; gap: 8px; }
  .proxy-member-select input { width: 22px; height: 22px; }
  .proxy-submit { width: 100%; min-height: 52px; margin-top: 12px; }
  .pending, .notice { background: #fff7ed; border-radius: 8px; padding: 10px; }
  .danger { background: #9a3412; color: white; }
  .proxy-history > ol > li, .proxy-history > ol > li > ul > li { display: block; }
  .proxy-history > ol > li { border-top: 1px solid #e5e7eb; padding: 10px 0; }
  .proxy-history small { display: block; margin: 4px 0; }
  .error { background: #fff1f0; color: #8a1c13; padding: 10px; border-radius: 8px; }
  @media (max-width: 640px) { .household-controls, .household-create, .add-member { grid-template-columns: 1fr; } .proxy-member { grid-template-columns: 1fr 1fr; } .proxy-member-select { grid-column: 1 / -1; } }
</style>
