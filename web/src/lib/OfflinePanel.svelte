<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { formatUtcTimestamp, utcTimestampMillis } from "./time";
  import {
    appendOfflineOperation, disableServiceWorker, expirePreparedSnapshot, exportPendingOperations, markOfflineNeedsReview, setOfflineStatus,
    purgeOfflineData, quarantineIfIdentityChanged, readOfflineState, recordOfflineOutcome,
    savePreparedSnapshot,
    type OfflineAttendee, type OfflineDistribution, type OfflineOperation, type OfflineSnapshot, type OfflineState,
  } from "./offline-store";

  type Venue = { id: string; name: string };
  type Context = { eventId: string; eventName: string; actorId: string; organizationId: string; role: string; venues: Venue[] };
  type Api = (path: string, init?: RequestInit) => Promise<any>;
  type Person = { attendee_id: string; action: "enter" | "exit"; venue_id: string; revision: number };

  export let api: Api;
  export let context: Context | null = null;
  export let onclose: () => void = () => {};
  export let onlogout: () => void = () => {};

  let localState: OfflineState = { snapshot: null, operations: [], receipts: [], generation: 0, quarantinedIdentity: null };
  let selectedVenueId = "";
  let attendeeId = "";
  let credentialHash = "";
  let qrInput = "";
  let search = "";
  let distributionId = "";
  let quantity = 1;
  let busy = false;
  let errorMessage = "";
  let statusMessage = "";
  let optedIn = false;
  let online = typeof navigator !== "undefined" && navigator.onLine;
  let identityVerified = false;
  let serverWriteAllowed = false;
  let storagePersisted = false;
  let verifiedActorId = "";
  let verifiedOrganizationId = "";
  let scanning = false;
  let video: HTMLVideoElement;
  let stream: MediaStream | null = null;
  let scanLatched = "";
  let channel: BroadcastChannel | null = null;
  let clockNow = Date.now();
  let expiryTask = "";

  $: snapshot = localState.snapshot;
  $: pendingOperations = localState.operations;
  $: receipts = localState.receipts;
  $: isExpired = Boolean(snapshot && utcTimestampMillis(snapshot.expiresAt) <= clockNow);
  $: readyForWrites = Boolean(snapshot && !isExpired && (!online || (identityVerified && serverWriteAllowed)) && !localState.quarantinedIdentity);
  $: people = (snapshot?.attendees ?? []).filter((item) => !search.trim() || item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  $: selectedPerson = snapshot?.attendees.find((person) => person.id === attendeeId) ?? null;
  $: distributions = snapshot?.distributions ?? [];
  $: distribution = distributions.find((item) => item.id === distributionId) ?? null;
  $: queuedForPerson = attendeeId ? pendingOperations.filter((item) => item.attendeeId === attendeeId) : [];
  $: projectedPerson = selectedPerson ? projectPerson(selectedPerson) : null;
  $: projectedUsage = selectedPerson && distribution ? projectUsage(selectedPerson, distribution) : null;
  $: distributionVenueAllowed = Boolean(snapshot && selectedPerson && projectedPerson && (projectedPerson.state === "in"
    ? projectedPerson.venueId === snapshot.venueId
    : !selectedPerson.registrationVenueId || selectedPerson.registrationVenueId === snapshot.venueId));
  $: canQueueDistribution = Boolean(readyForWrites && distributionVenueAllowed && distribution && selectedPerson && Number.isInteger(quantity) && quantity > 0 && projectedUsage && quantity <= projectedUsage.remaining && pendingOperations.length < 500 && !queuedForPerson.some((operation) => operation.status === "retry_only" || (operation.status === "needs_review" && operation.reason !== "limit_reached")));
  $: canQueueMovement = Boolean(readyForWrites && selectedPerson && projectedPerson && !projectedPerson.needsReview && pendingOperations.length < 500);

  onMount(() => {
    const onlineHandler = () => { online = true; void validateCurrentSession(); };
    const offlineHandler = () => { online = false; identityVerified = false; };
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    const timer = window.setInterval(() => {
      clockNow = Date.now();
      if (snapshot && isExpired && expiryTask !== snapshot.expiresAt) {
        const expiring = snapshot.expiresAt; expiryTask = expiring;
        void expirePreparedSnapshot(localState.generation).then((expired) => { if (expired) { void reloadState(); attendeeId = ""; credentialHash = ""; statusMessage = "準備データの12時間有効期限が切れたため、氏名とQR照合一覧を消去しました。未同期操作に必要な最小限の照合情報は結果確認まで保持します。"; } }).catch((error) => errorMessage = messageOf(error));
      }
    }, 1000);
    try {
      channel = new BroadcastChannel("tsudoi-offline");
      channel.onmessage = (event) => { if (["purged", "quarantined", "expired", "prepared"].includes(event.data?.type)) void reloadState(); };
    } catch { channel = null; }
    if (navigator.onLine) void validateCurrentSession().finally(() => reloadState());
    else void reloadState();
    return () => { clearInterval(timer); window.removeEventListener("online", onlineHandler); window.removeEventListener("offline", offlineHandler); };
  });
  onDestroy(() => { stopScanner(); channel?.close(); });

  function formatDate(value: string) { return formatUtcTimestamp(value); }
  function reasonLabel(reason: string) {
    const labels: Record<string, string> = {
      revision_conflict: "状態が別の端末で更新されました。オンラインで現在の状態を確認してください。",
      state_conflict: "現在の状態では操作が成立しませんでした。オンラインで確認してください。",
      limit_reached: "上限によりサーバーの配布記録は不成立です。現場の受渡し数量を照合してください。",
      dependency_conflict: "前の入退館操作が成立しなかったため、この後の操作を保留しています。",
      result_unconfirmed_after_permission_or_scope_change: "権限または会場の状態が変わり、前回の結果を確認できません。元の担当者に照会してください。",
    };
    return labels[reason] ?? "オンラインで結果を確認してください。";
  }

  async function reloadState() {
    try {
      let next = await readOfflineState();
      if (online && identityVerified && verifiedActorId && verifiedOrganizationId && next.snapshot
        && (next.snapshot.actorId !== verifiedActorId || next.snapshot.organizationId !== verifiedOrganizationId)) {
        await quarantineIfIdentityChanged(verifiedActorId, verifiedOrganizationId);
        next = await readOfflineState();
        attendeeId = ""; credentialHash = "";
      }
      localState = next;
      if (snapshot && !distributions.some((item) => item.id === distributionId)) distributionId = distributions[0]?.id ?? "";
      if (snapshot && !snapshot.attendees.some((person) => person.id === attendeeId)) { attendeeId = ""; credentialHash = ""; }
    } catch (error) { errorMessage = messageOf(error); }
  }
  async function validateCurrentSession() {
    if (!navigator.onLine) { identityVerified = false; serverWriteAllowed = false; return false; }
    try {
      const session = await api("/session");
      const current = await readOfflineState();
      const storedIdentity = current.snapshot
        ? { actorId: current.snapshot.actorId, organizationId: current.snapshot.organizationId }
        : current.quarantinedIdentity;
      if (storedIdentity && (storedIdentity.actorId !== session.actorId || storedIdentity.organizationId !== session.organizationId)) {
        await quarantineIfIdentityChanged(session.actorId, session.organizationId);
        identityVerified = false; verifiedActorId = session.actorId; verifiedOrganizationId = session.organizationId; attendeeId = ""; credentialHash = "";
        localState = await readOfflineState();
        statusMessage = "別のアカウントまたは組織でログイン中です。準備データの参加者名を隠し、未同期操作は元のアカウント用に保留しました。";
        return false;
      }
      identityVerified = true; serverWriteAllowed = session.role !== "viewer"; verifiedActorId = session.actorId; verifiedOrganizationId = session.organizationId; localState = current;
      if (!serverWriteAllowed) statusMessage = "現在の権限は閲覧のみです。未同期操作は追加できません。";
      return true;
    } catch {
      identityVerified = false; serverWriteAllowed = false;
      return false;
    }
  }

  async function prepareOffline() {
    if (!context || !optedIn || busy || context.role === "viewer") return;
    if (!selectedVenueId) { errorMessage = "会場を選んでください。"; return; }
    if (!navigator.locks) { errorMessage = "このブラウザーは安全な未同期操作の同期に対応していません。オンライン受付または対応ブラウザーを利用してください。"; return; }
    busy = true; errorMessage = ""; statusMessage = "受付データを準備しています…";
    try {
      await navigator.locks.request("tsudoi-offline-prepare", { mode: "exclusive" }, async () => {
        const before = await readOfflineState();
        if (before.snapshot) throw new Error("別のタブで受付データが準備されています。現在の準備データを確認してください。");
        if (before.operations.length) throw new Error("未同期操作があります。先に同期するか、書き出して確認後に消去してください。");
        const session = await api("/session");
        if (session.actorId !== context!.actorId || session.organizationId !== context!.organizationId || session.role === "viewer") throw new Error("ログインアカウントまたは受付権限を確認してください。");
        const params = new URLSearchParams({ venueId: selectedVenueId });
        const result = await api(`/events/${context!.eventId}/offline-snapshot?${params}`);
        const prepared: OfflineSnapshot = result.snapshot;
        if (prepared.actorId !== session.actorId || prepared.organizationId !== session.organizationId || prepared.eventId !== context!.eventId || prepared.venueId !== selectedVenueId) {
          throw new Error("サーバーの準備データが現在のイベントまたはアカウントと一致しません。");
        }
        if (prepared.attendees.length > 1000 || prepared.distributions.length > 100 || prepared.attendees.reduce((count, person) => count + person.credentials.length, 0) > 10000) throw new Error("準備データの上限を超えています。対象人数や受付QRを確認してください。");
        await enableStaticShell();
        try { storagePersisted = navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { storagePersisted = false; }
        await savePreparedSnapshot(prepared, before.generation);
        localState = await readOfflineState();
        distributionId = prepared.distributions[0]?.id ?? "";
        attendeeId = ""; credentialHash = "";
        identityVerified = true; serverWriteAllowed = true;
        statusMessage = `${prepared.attendees.length} 人分の受付データをこの端末に準備しました。有効期限は12時間です。${storagePersisted ? "ブラウザーに保存の維持を依頼しました。" : "ブラウザーによる保存維持は保証されません。"}紙にも控えてください。`;
      });
    } catch (error) { errorMessage = friendly(error); statusMessage = "準備を完了できませんでした。通信と未同期操作を確認してください。"; }
    finally { busy = false; }
  }
  async function enableStaticShell() {
    if (!("serviceWorker" in navigator)) throw new Error("このブラウザーはオフライン画面を準備できません。オンラインで受付してください。");
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (registration.installing) await new Promise<void>((resolve, reject) => {
      const worker = registration.installing!;
      worker.addEventListener("statechange", () => { if (worker.state === "activated") resolve(); if (worker.state === "redundant") reject(new Error("オフライン画面の準備に失敗しました。")); });
    });
  }

  function setAttendee(personId: string, proof = "") { attendeeId = personId; credentialHash = proof; statusMessage = ""; errorMessage = ""; }
  async function resolveQr() {
    const raw = qrInput.trim(); qrInput = "";
    if (!raw || !snapshot) return;
    try {
      const parsed = new URL(raw, location.origin);
      const match = parsed.pathname.match(/^\/public\/tickets\/([^/]+)\/check-in\/([^/]+)\/?$/);
      if (!match || parsed.origin !== location.origin) throw new Error("受付QRリンクの形式を確認してください。");
      const token = decodeURIComponent(match[2]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
      const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const person = snapshot.attendees.find((attendee) => attendee.ticket.id === decodeURIComponent(match[1]) && attendee.credentials.some((credential) => credential.credentialHash === hash && utcTimestampMillis(credential.expiresAt) > Date.now()));
      if (!person) throw new Error("このQRは準備データに含まれていないか、有効期限が切れています。オンラインで本人確認してください。");
      setAttendee(person.id, hash);
      statusMessage = `${person.name}さんを確認しました。記録する操作を選んでください。`;
    } catch (error) { errorMessage = messageOf(error); }
  }
  async function startScanner() {
    const browser = window as Window & { BarcodeDetector?: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } };
    if (!browser.BarcodeDetector) { errorMessage = "この端末ではカメラ読取に対応していません。受付QRリンクを貼り付けてください。"; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      scanning = true; await tick(); video.srcObject = stream; await video.play();
      const detector = new browser.BarcodeDetector({ formats: ["qr_code"] });
      while (scanning && video && !video.paused) {
        try {
          const found = await detector.detect(video);
          const value = found[0]?.rawValue ?? "";
          if (value && value !== scanLatched) { scanLatched = value; qrInput = value; await resolveQr(); }
          if (!value) scanLatched = "";
        } catch { /* retry on the next frame */ }
        await new Promise((resolve) => setTimeout(resolve, 160));
      }
    } catch { errorMessage = "カメラを利用できません。受付QRリンクを貼り付けてください。"; stopScanner(); }
  }
  function stopScanner() { scanning = false; stream?.getTracks().forEach((track) => track.stop()); stream = null; }

  function projectPerson(person: OfflineAttendee) {
    let state = person.presence.state, venueId = person.presence.venueId, revision = person.presence.revision;
    let needsReview = false;
    for (const operation of pendingOperations.filter((item) => item.type === "presence" && item.attendeeId === person.id).sort((a, b) => a.sequence - b.sequence)) {
      if (operation.status !== "pending") { needsReview = true; continue; }
      const action = String(operation.payload.action);
      if (action === "enter" && state === "out") { state = "in"; venueId = snapshot?.venueId ?? null; revision += 1; }
      else if (action === "exit" && state === "in" && venueId === snapshot?.venueId) { state = "out"; venueId = null; revision += 1; }
    }
    return { state, venueId, revision, needsReview };
  }
  function projectUsage(person: OfflineAttendee, round: OfflineDistribution) {
    const base = person.distributionUsage.find((usage) => usage.distributionId === round.id);
    const queued = pendingOperations.filter((operation) => operation.type === "distribution" && operation.distributionId === round.id && operation.attendeeId === person.id && (operation.status === "pending" || operation.status === "retry_only"))
      .reduce((sum, operation) => sum + Number(operation.payload.quantity ?? 0), 0);
    const used = (base?.used ?? 0) + queued;
    return { used, remaining: Math.max(0, round.maxPerAttendee - used) };
  }

  async function queuePresence(action: "enter" | "exit") {
    if (!selectedPerson || !projectedPerson || !canQueueMovement || (action === "enter" && projectedPerson.state !== "out") || (action === "exit" && projectedPerson.state !== "in")) return;
    const requestId = crypto.randomUUID();
    await queueOperation({
      requestId, eventId: snapshot!.eventId, attendeeId: selectedPerson.id, type: "presence", createdAt: new Date().toISOString(), sequence: 0, status: "pending",
      payload: { requestId, attendeeId: selectedPerson.id, ...(credentialHash ? { credentialHash } : {}), action, venueId: snapshot!.venueId, expectedRevision: projectedPerson.revision, occurredAt: new Date().toISOString() },
    }, "入退館操作を未同期として保存しました。同期後にサーバーの結果を確認してください。");
  }
  async function queueDistribution() {
    if (!selectedPerson || !distribution || !projectedUsage || !canQueueDistribution || !snapshot) return;
    const requestId = crypto.randomUUID();
    await queueOperation({
      requestId, eventId: snapshot.eventId, distributionId: distribution.id, attendeeId: selectedPerson.id, type: "distribution", createdAt: new Date().toISOString(), sequence: 0, status: "pending",
      payload: { requestId, attendeeId: selectedPerson.id, ...(credentialHash ? { credentialHash } : {}), quantity, venueId: snapshot.venueId },
    }, "配布操作を未同期として保存しました。同期後にサーバーの結果を確認してください。");
  }
  async function queueOperation(operation: OfflineOperation, success: string) {
    if (!readyForWrites) return;
    busy = true; errorMessage = "";
    try { await appendOfflineOperation(operation); localState = await readOfflineState(); quantity = 1; statusMessage = success; }
    catch (error) { errorMessage = friendly(error); statusMessage = "操作を保存できませんでした。記録済みとは扱っていません。紙に控えてオンライン復旧後に確認してください。"; }
    finally { busy = false; }
  }

  async function syncQueue() {
    if (!online || busy || !pendingOperations.length) return;
    busy = true; errorMessage = "";
    try {
      if (!navigator.locks) throw new Error("このブラウザーは複数タブ間の安全な同期に対応していません。受付には1タブだけを使用してください。");
      await navigator.locks.request("tsudoi-offline-sync", { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("別のタブが未同期操作を処理しています。完了後に再確認してください。");
        if (!await validateCurrentSession() || !serverWriteAllowed) throw new Error("元の担当者で、受付操作ができる権限のアカウントにログインしてから同期してください。");
        const captured = await readOfflineState();
        const ordered = [...captured.operations].sort((a, b) => a.sequence - b.sequence);
        const blocked = new Set<string>();
        for (const operation of ordered) {
          if (operation.status === "needs_review") { if (operation.type === "presence") blocked.add(operation.attendeeId); continue; }
          if (operation.type === "presence" && blocked.has(operation.attendeeId)) {
            await markOfflineNeedsReview(operation.requestId, captured.generation, operation.createdAt, "dependency_conflict");
            continue;
          }
          try {
            await syncOne(operation, captured);
            const latest = await readOfflineState();
            if (latest.operations.some((item) => item.requestId === operation.requestId && item.status === "needs_review") && operation.type === "presence") blocked.add(operation.attendeeId);
          } catch (error) {
            const latest = await readOfflineState();
            const current = latest.operations.find((item) => item.requestId === operation.requestId);
            if (current?.status === "needs_review" || current?.status === "retry_only") {
              if (operation.type === "presence") blocked.add(operation.attendeeId);
              const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
              if (errorStatus(error) === 401 || ["venue_not_assigned", "unauthorized"].includes(code)) {
                if (code === "venue_not_assigned") { serverWriteAllowed = false; statusMessage = "この会場の担当権限がありません。未同期操作は保留しました。担当者に照会してください。"; }
                break;
              }
              continue;
            }
            break;
          }
        }
      });
      localState = await readOfflineState();
      statusMessage = `同期を確認しました。未同期 ${localState.operations.filter((item) => item.status === "pending").length} 件、結果未確認 ${localState.operations.filter((item) => item.status === "retry_only").length} 件、要照合 ${localState.operations.filter((item) => item.status === "needs_review").length} 件です。`;
    } catch (error) { errorMessage = friendly(error); statusMessage = "未同期の操作を保留しています。通信とログイン状態を確認してください。"; }
    finally { busy = false; }
  }
  async function syncOne(operation: OfflineOperation, captured: OfflineState) {
    const eventId = operation.eventId, requestId = operation.requestId;
    const statusPath = operation.type === "presence"
      ? `/events/${eventId}/presence/movements/by-request/${requestId}`
      : `/events/${eventId}/distributions/${operation.distributionId}/claims/by-request/${requestId}`;
    const postPath = operation.type === "presence"
      ? `/events/${eventId}/presence/movements`
      : `/events/${eventId}/distributions/${operation.distributionId}/claims`;
    try {
      let result: any;
      try { result = await api(statusPath); }
      catch (error) { if (errorStatus(error) !== 404) throw error; result = await api(postPath, { method: "POST", body: JSON.stringify(operation.payload) }); }
      const outcome = result.outcome ?? result.claim?.outcome;
      const accepted = outcome === "accepted";
      const usage = operation.type === "distribution" ? (result.claim ?? result) : null;
      const expectedIdentity = captured.snapshot ?? captured.quarantinedIdentity;
      if (!expectedIdentity) throw new Error("この操作の元担当者を確認できません。");
      await recordOfflineOutcome(requestId, captured.generation, operation.createdAt, expectedIdentity.actorId, expectedIdentity.organizationId, {
        kind: accepted ? "accepted" : "needs_review", outcome,
        summary: operation.type === "presence" ? (accepted ? `${String(operation.payload.action) === "enter" ? "入館" : "退館"}の記録を同期しました。` : "入退館の結果を要照合にしました。") : (accepted ? "配布を記録しました。" : "サーバーの配布記録は不成立です。現場の受渡し数量を照合してください。"),
        ...(result.presence ? { presence: { state: result.presence.state, venueId: result.presence.venue_id ?? null, revision: result.presence.revision, updatedAt: result.presence.updated_at ?? null } } : {}),
        ...(usage && typeof (result.used ?? usage.used) === "number" && typeof (result.remaining ?? usage.remaining) === "number" ? { used: result.used ?? usage.used, remaining: result.remaining ?? usage.remaining } : {}),
      });
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 400 && status < 500 && status !== 429) {
        await setOfflineStatus(requestId, captured.generation, operation.createdAt, "retry_only", "result_unconfirmed_after_permission_or_scope_change");
      }
      throw error;
    }
    const latest = await readOfflineState();
    if (latest.generation !== captured.generation || latest.snapshot?.actorId !== captured.snapshot?.actorId || latest.snapshot?.organizationId !== captured.snapshot?.organizationId) throw new Error("同期中に準備データが切り替わりました。残りの操作を停止しました。");
  }

  function exportQueue() {
    const exported = exportPendingOperations(localState);
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `tsudoi-offline-operations-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
    statusMessage = "未同期操作を書き出しました。ファイルにQR情報やメールアドレスは含めていません。";
  }
  async function clearPrepared() {
    if (!window.confirm("この端末の準備データ、未同期操作、確認履歴をすべて消去します。未同期の記録は戻せません。先に書き出しましたか？")) return;
    busy = true;
    try { await purgeOfflineData(); await disableServiceWorker(); await reloadState(); attendeeId = ""; credentialHash = ""; distributionId = ""; statusMessage = "準備データと未同期操作を消去しました。"; }
    catch (error) { errorMessage = friendly(error); }
    finally { busy = false; }
  }
  function closePanel() { stopScanner(); onclose(); }
  function errorStatus(error: unknown) { return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 0; }
  function messageOf(error: unknown) { return error instanceof Error ? error.message : "オフライン受付を処理できませんでした。"; }
  function friendly(error: unknown) {
    const text = messageOf(error);
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code: unknown }).code);
      const map: Record<string, string> = { venue_required: "担当会場を選択してください。", venue_not_assigned: "この会場の担当者ではありません。", not_found: "操作または対象者を確認できません。元の担当者でオンライン照会してください。", revision_conflict: "状態が更新されています。オンラインで最新状態を確認してください。", state_conflict: "現在の入退館状態では実行できません。オンラインで確認してください。", limit_reached: "サーバーの配布記録は不成立です。現場の受渡し数量を照合してください。" };
      if (map[code]) return map[code];
    }
    return text;
  }
</script>

<svelte:head><title>オフライン受付 · tsudoi</title></svelte:head>
<main class="offline-shell">
  <header><p class="eyebrow">PREPARED OPERATIONS</p><h1>tsudoi</h1><p>準備したイベント・会場だけの受付画面です。</p></header>
  <section class="offline-panel" aria-labelledby="offline-panel-title">
    <h2 id="offline-panel-title">オフライン受付</h2>
    <p class="muted">準備した名簿を使って、配布と入退館を端末に記録します。オンライン同期までは「未同期」で、サーバーの記録成立は確認できません。</p>
    {#if context && !snapshot && (!localState.quarantinedIdentity || (identityVerified && localState.quarantinedIdentity.actorId === context.actorId && localState.quarantinedIdentity.organizationId === context.organizationId))}
      <section class="prepare" aria-labelledby="prepare-title"><h3 id="prepare-title">この端末に受付データを準備</h3><p>{context.eventName}</p>
        <label>準備する会場<select bind:value={selectedVenueId}><option value="">会場を選択</option>{#each context.venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>
        <label class="inline"><input type="checkbox" bind:checked={optedIn} />この端末に受付データを準備する</label>
        <p class="warning">名簿1,000人・受付QR 10,000件まで。氏名と入退館・配布の最小情報を12時間保存します。メール、所属、申込回答、QR画像は保存しません。ブラウザーの空き容量や設定によりデータが消去される場合があります。通信が戻るまで紙にも控えてください。</p>
        <p class="muted">通信断の間は配布・入退館のみ使えます。カードの発行、世帯代理受取、名簿変更は利用できません。</p>
        <button type="button" disabled={busy || !optedIn || !selectedVenueId} onclick={() => void prepareOffline()}>オフライン利用を準備</button>
      </section>
    {/if}
    {#if localState.quarantinedIdentity && !snapshot}
      <section class="quarantine" aria-labelledby="quarantine-title"><h3 id="quarantine-title">{identityVerified ? (localState.quarantinedIdentity.reason === "snapshot_expired" ? "準備データの有効期限が切れました" : "参加者情報を再準備してください") : "元の担当アカウントで確認してください"}</h3><p>{identityVerified ? (localState.quarantinedIdentity.reason === "snapshot_expired" ? "参加者名とQR照合一覧は消去済みです。未同期操作に必要な最小限の照合情報は結果確認まで保持します。新しい受付データを準備してください。" : "参加者名などの準備情報は消去済みです。未同期操作は確認できます。") : "別のアカウントまたは組織でログインしたため、参加者名などの準備情報を隠しました。未同期操作は元の担当者だけが同期できます。"}</p>
        <p>{localState.operations.length} 件を保留中。元のアカウントに戻って結果を確認するか、操作を書き出してから消去してください。</p>
        <button type="button" disabled={!online} onclick={() => void validateCurrentSession()}>元のアカウントを確認</button>
      </section>
    {/if}
    {#if snapshot && (!online || identityVerified)}
      <section class="prepared" aria-labelledby="prepared-title"><h3 id="prepared-title">{snapshot.eventName} · {snapshot.venueName}</h3>
        <p>準備: {formatDate(snapshot.preparedAt)} · 有効期限: {formatDate(snapshot.expiresAt)}</p>
        {#if isExpired}<p class="warning" role="status">準備データの期限が切れています。氏名とQR照合一覧は消去されました。未同期操作に必要な最小限の照合情報は結果確認まで保持し、新しい操作は追加できません。</p>{/if}
        {#if !online}<p class="offline-indicator" role="status">オフラインです。操作はこの端末にのみ保存されます。</p>{:else if !identityVerified}<p class="warning" role="status">サーバーのログイン状態を確認できません。操作の追加と同期は停止しています。</p>{/if}
        {#if snapshot.role === "staff"}<p>担当会場: {snapshot.venueName}</p>{/if}
        <label>名簿から参加者を検索<input bind:value={search} autocomplete="off" placeholder="氏名" disabled={!readyForWrites || busy} /></label>
        <label>参加者を選択<select bind:value={attendeeId} disabled={!readyForWrites || busy} onchange={(event) => { credentialHash = ""; setAttendee(event.currentTarget.value); }}><option value="">参加者を選択</option>{#each people as person}<option value={person.id}>{person.name}</option>{/each}</select></label>
        <details><summary>受付QRから参加者を確認</summary><label>受付QRリンク<input aria-label="受付QRリンク" bind:value={qrInput} autocomplete="off" inputmode="url" placeholder="QRを読み取るか、リンクを貼り付け" disabled={!readyForWrites || busy} /></label><button type="button" disabled={!readyForWrites || busy || !qrInput.trim()} onclick={() => void resolveQr()}>QRから参加者を確認</button>
          {#if scanning}<video bind:this={video} playsinline muted aria-label="QR読取カメラ"></video><button type="button" onclick={stopScanner}>カメラを停止</button>{:else}<button type="button" disabled={!readyForWrites || busy} onclick={() => void startScanner()}>カメラでQRを読む</button>{/if}
        </details>
        {#if selectedPerson}
          <section class="selected-person" aria-labelledby="offline-person-title"><h4 id="offline-person-title">{selectedPerson.name}</h4>
            {#if projectedPerson?.needsReview}<p class="warning">この参加者には要照合の入退館操作があります。結果の確認が済むまで、新しい入退館を追加できません。</p>{:else}<p>現在の見込み: {projectedPerson?.state === "in" ? (projectedPerson.venueId === snapshot.venueId ? `在館中（${snapshot.venueName}）` : "別会場に在館中") : selectedPerson.presence.revision === 0 ? "未入館（記録なし）" : "退館中"}{#if queuedForPerson.length} · 未同期操作 {queuedForPerson.length} 件を反映{/if}</p>{/if}
            <div class="actions"><button type="button" disabled={!canQueueMovement || projectedPerson?.state !== "out" || busy} onclick={() => void queuePresence("enter")}>入館を記録</button><button type="button" class="quiet" disabled={!canQueueMovement || projectedPerson?.state !== "in" || projectedPerson?.venueId !== snapshot.venueId || busy} onclick={() => void queuePresence("exit")}>退館を記録</button></div>
          </section>
          {#if distributions.length}<section class="distribution-offline" aria-labelledby="offline-distribution-title"><h4 id="offline-distribution-title">配布</h4>
            <label>配布回<select bind:value={distributionId} disabled={!readyForWrites || busy}><option value="">配布回を選択</option>{#each distributions as round}<option value={round.id}>{round.name}（{round.unit}）</option>{/each}</select></label>
            {#if distribution}<p>この方の見込み: {projectedUsage?.used} 使用・残り {projectedUsage?.remaining} {distribution.unit}（上限 {distribution.maxPerAttendee}）</p>{/if}
            {#if !distributionVenueAllowed}<p class="warning">この方の現在の会場では配布できません。入館中は現在の会場、退館中は登録時の会場を使います。</p>{/if}
            <label>数量<input bind:value={quantity} type="number" min="1" max="1000" step="1" inputmode="numeric" disabled={!readyForWrites || busy} /></label>
            <button type="button" disabled={!canQueueDistribution || busy} onclick={() => void queueDistribution()}>配布を記録</button>
          </section>{/if}
        {/if}
      </section>
    {:else if snapshot}<p class="warning" role="status">準備データの利用者を確認しています。氏名は確認が終わるまで表示しません。</p>{/if}
    {#if online && !identityVerified}<button type="button" class="quiet" disabled={busy} onclick={() => void validateCurrentSession()}>ログイン状態を確認</button>{/if}
    {#if pendingOperations.length}<section class="queue" aria-labelledby="offline-queue-title"><h3 id="offline-queue-title">端末内の操作</h3><p>未同期 {pendingOperations.filter((operation) => operation.status === "pending").length} 件 · 結果未確認 {pendingOperations.filter((operation) => operation.status === "retry_only").length} 件 · 要照合 {pendingOperations.filter((operation) => operation.status === "needs_review").length} 件 / 最大500件</p>
      <ol>{#each pendingOperations as operation (operation.requestId)}<li><strong>{operation.type === "presence" ? (operation.payload.action === "enter" ? "入館" : "退館") : "配布"}</strong><span>{operation.status === "needs_review" ? "要照合" : operation.status === "retry_only" ? "結果未確認" : "未同期"} · {operation.attendeeId.slice(0, 8)} · {operation.requestId}</span>{#if operation.reason}<small>{reasonLabel(operation.reason)}</small>{/if}</li>{/each}</ol>
      <button type="button" disabled={!online || busy} onclick={() => void syncQueue()}>未同期操作を同期</button>
    </section>{/if}
    {#if receipts.length}<section class="receipts" aria-labelledby="offline-receipts-title"><h3 id="offline-receipts-title">同期結果</h3><ol>{#each receipts.slice(0, 50) as receipt (receipt.requestId)}<li><strong>{receipt.summary}</strong><span>{receipt.requestId} · {formatDate(receipt.completedAt)}</span></li>{/each}</ol></section>{/if}
    {#if snapshot || localState.operations.length || localState.quarantinedIdentity}
      <section class="cleanup" aria-labelledby="offline-cleanup-title"><h3 id="offline-cleanup-title">書き出し・解除</h3><p>未同期操作は結果が確定するまで消去しないでください。書き出しファイルには QR の認証情報を含めません。</p>
        <button type="button" class="quiet" disabled={!pendingOperations.length} onclick={exportQueue}>未同期操作を書き出す</button>
        <button type="button" class="danger" disabled={busy} onclick={() => void clearPrepared()}>準備データと未同期操作を消去</button>
      </section>
    {/if}
    {#if online && !pendingOperations.length && !localState.quarantinedIdentity}<button type="button" class="quiet" onclick={() => void onlogout()}>ログアウト</button>{/if}
    {#if online}<button type="button" class="quiet" onclick={closePanel}>通常画面に戻る</button>{/if}
    {#if statusMessage}<p role="status" aria-live="polite">{statusMessage}</p>{/if}
    {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
  </section>
</main>

<style>
  .offline-shell { max-width: 760px; margin: 0 auto; padding: 16px; }
  .offline-panel, .prepare, .prepared, .selected-person, .distribution-offline, .queue, .receipts, .cleanup, .quarantine { border: 1px solid #d8ddd8; border-radius: 12px; padding: 14px; margin: 14px 0; }
  .offline-panel h2 { margin-top: 0; }
  .offline-panel label { display: grid; gap: 6px; margin: 10px 0; }
  .offline-panel .inline { display: flex; align-items: center; gap: 8px; }
  .offline-panel input, .offline-panel select, .offline-panel button { min-height: 46px; font: inherit; }
  .offline-panel button { width: 100%; margin-top: 8px; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .warning, .offline-indicator { padding: 10px; border-radius: 8px; background: #fff7ed; }
  .offline-indicator { background: #ecfdf5; }
  .muted, small { color: #52606d; }
  .queue ol, .receipts ol { padding-left: 22px; }
  .queue li, .receipts li { display: grid; gap: 4px; border-top: 1px solid #e5e7eb; padding: 9px 0; overflow-wrap: anywhere; }
  .danger { background: #9a3412; color: white; }
  .error { color: #8a1c13; background: #fff1f0; padding: 10px; border-radius: 8px; }
  @media (max-width: 560px) { .offline-shell { padding: 8px; } .offline-panel, .prepare, .prepared, .selected-person, .distribution-offline, .queue, .receipts, .cleanup, .quarantine { padding: 10px; } .actions { grid-template-columns: 1fr; } }
</style>
