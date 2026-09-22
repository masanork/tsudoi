<script lang="ts">
  import { onMount } from "svelte";
  import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
  import QRCode from "qrcode";

  type ParticipantTicket = { id: string; status: string; event_name: string; starts_at: string; ends_at: string; timezone: string; venue_name: string | null; cancellation_closes_at: string | null };
  let administratorName = "";
  let administratorEmail = "";
  let administratorAvatarUrl = "";
  let organizationId = "";
  let profileName = "";
  let profileEmail = "";
  let profileAvatarUrl = "";
  let profileMessage = "";
  let initialSetupRequired = false;
  let workspaceReady = false;
  let isAdministrator = false;
  let screen: "setup" | "home" | "event" | "admin" = "setup";
  let setupMessage = "この tsudoi を使い始めるには、初期管理者の Passkey を登録してください。";
  let events: Array<{ id: string; name: string; starts_at: string; ends_at: string; status: string; scheduling_enabled?: number; schedule_status?: string }> = [];
  let message = "イベントを読み込んでいます。";
  let eventName = "";
  let startsAt = "";
  let endsAt = "";
  let eventCapacity = "";
  let registrationOpensAt = "";
  let registrationClosesAt = "";
  let schedulingEnabled = false;
  let initialScheduleOptions: Array<{ date: string; note: string }> = [];
  let scheduleDraftDates: string[] = [];
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let ticketLink = "";
  let checkinMessage = "";
  let selectedEventId = "";
  let schedule: { enabled: boolean; status: string; date: string | null; options: Array<{ id: string; date: string; note: string; yes: number; maybe: number; no: number }> } | null = null;
  let scheduleDate = "";
  let scheduleNote = "";
  let metrics: { registrations: number; issued: number; cancelled: number; checked_in: number; not_checked_in: number } | null = null;
  let rosterFields: Array<{ field_key: string; label: string }> = [];
  let rosterAttendees: Array<{ id: string; name: string; email_normalized: string | null; ticket_status: string; answers: Record<string, unknown> }> = [];
  let fieldKey = "";
  let fieldLabel = "";
  let fieldType = "text";
  let fieldOptions = "";
  let fieldRequired = false;
  let fieldMessage = "";
  let organizers: Array<{ user_id: string; role: string; display_name: string; email_normalized: string | null }> = [];
  let organizationMembers: Array<{ id: string; display_name: string; email_normalized: string | null; role: string }> = [];
  let selectedCohostId = "";
  let announcementSubject = "";
  let announcementBody = "";
  let announcementMessage = "";
  const fieldKeyPattern = "[a-z][a-z0-9_]{0,62}";
  const registerMatch = typeof window !== "undefined" ? window.location.pathname.match(/^\/events\/([^/]+)\/register$/) : null;
  const registrationEventId = registerMatch?.[1] ?? "";
  const scheduleMatch = typeof window !== "undefined" ? window.location.pathname.match(/^\/events\/([^/]+)\/schedule$/) : null;
  const scheduleEventId = scheduleMatch?.[1] ?? "";
  let publicEvent: { name: string; description: string; starts_at: string } | null = null;
  let publicFields: Array<{ field_key: string; label: string; field_type: string; required: number; options_json: string }> = [];
  let registrationName = ""; let registrationEmail = ""; let registrationAnswers: Record<string, string | string[] | boolean> = {}; let registrationMessage = "";
  let publicSchedule: { event: { name: string; description: string; timezone: string; schedule_status: string }; options: Array<{ id: string; date: string; note: string; yes: number; maybe: number; no: number }> } | null = null;
  let scheduleRespondentName = "";
  let scheduleRespondentId = "";
  let scheduleResponseMessage = "";
  let scheduleResponses: Record<string, string> = {};
  let agentConnection: { mcpUrl: string; token: string; expiresInDays: number } | null = null;
  let agentConnections: Array<{ id: string; scope: string; expires_at: string; revoked_at: string | null; created_at: string }> = [];
  let issuedTicket: { id: string; token: string } | null = null;
  let ticketQr = "";
  let passkeyMessage = "";
  let participantTicket: ParticipantTicket | null = null;
  let participantMessage = "チケットを確認しています。";
  const ticketPage = typeof window !== "undefined" && window.location.pathname === "/ticket";

  function identiconUrl(name: string) {
    const seed = name.trim() || "tsudoi";
    let hash = 2166136261;
    for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    const color = `hsl(${Math.abs(hash) % 360} 55% 42%)`;
    const cells = Array.from({ length: 15 }, (_, index) => ((hash >>> (index % 24)) & 1) === 1);
    const squares = cells.flatMap((filled, index) => {
      if (!filled) return [];
      const row = Math.floor(index / 3), column = index % 3;
      return [`<rect x="${column * 20 + 10}" y="${row * 20 + 10}" width="16" height="16" rx="3"/>`, `<rect x="${(4 - column) * 20 + 10}" y="${row * 20 + 10}" width="16" height="16" rx="3"/>`];
    }).join("");
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#e8f2ef"/><g fill="${color}">${squares}</g></svg>`)}`;
  }
  function isoDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  function calendarDays(month: Date) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1), leading = first.getDay();
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: Math.ceil((leading + days) / 7) * 7 }, (_, index) => index < leading || index >= leading + days ? null : isoDate(new Date(month.getFullYear(), month.getMonth(), index - leading + 1)));
  }
  function monthLabel(month: Date) { return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(month); }
  function moveCalendarMonth(offset: number) { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1); }
  function toggleDate(dates: string[], date: string) { return dates.includes(date) ? dates.filter((item) => item !== date) : [...dates, date].sort(); }
  function toggleInitialDate(date: string) { initialScheduleOptions = toggleDate(initialScheduleOptions.map((option) => option.date), date).map((selectedDate) => initialScheduleOptions.find((option) => option.date === selectedDate) ?? { date: selectedDate, note: "" }); }
  function toggleScheduleDraftDate(date: string) { scheduleDraftDates = toggleDate(scheduleDraftDates, date); }
  async function selectAdministratorAvatar(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 200_000) { setupMessage = "画像は PNG・JPEG・WebP の200KB以下にしてください。"; return; }
    administratorAvatarUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("画像を読み込めませんでした。")); reader.readAsDataURL(file); });
  }
  async function selectProfileAvatar(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 200_000) { profileMessage = "画像は PNG・JPEG・WebP の200KB以下にしてください。"; return; }
    profileAvatarUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("画像を読み込めませんでした。")); reader.readAsDataURL(file); });
  }

  onMount(() => {
    if (ticketPage) void loadParticipantTicket();
    else if (registrationEventId) void loadRegistration();
    else if (scheduleEventId) { scheduleRespondentId = localStorage.getItem(`tsudoi-schedule-${scheduleEventId}`) ?? crypto.randomUUID(); localStorage.setItem(`tsudoi-schedule-${scheduleEventId}`, scheduleRespondentId); void loadPublicSchedule(); }
    else {
      void initializeOrganizer();
    }
  });

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`/api${path}`, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...init.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "リクエストに失敗しました");
    return body;
  }
  async function loadEvents() {
    try { events = await api("/events"); message = `${events.length} 件のイベントを読み込みました。`; }
    catch (error) { message = error instanceof Error ? error.message : "読み込みに失敗しました。"; }
  }
  async function createEvent() {
    try {
      await api("/events", { method: "POST", body: JSON.stringify({ name: eventName, startsAt: schedulingEnabled ? undefined : startsAt, endsAt: schedulingEnabled ? undefined : endsAt, schedulingEnabled, initialScheduleOptions: schedulingEnabled ? initialScheduleOptions : undefined, registrationMode: "hybrid", capacity: eventCapacity ? Number(eventCapacity) : undefined, registrationOpensAt: registrationOpensAt || undefined, registrationClosesAt: registrationClosesAt || undefined }) });
      eventName = ""; eventCapacity = ""; registrationOpensAt = ""; registrationClosesAt = ""; schedulingEnabled = false; initialScheduleOptions = []; await loadEvents(); message = "イベントを作成しました。";
    } catch (error) { message = error instanceof Error ? error.message : "作成に失敗しました。"; }
  }
  async function loadSchedule(eventId: string) {
    try { schedule = await api(`/events/${eventId}/schedule`); }
    catch (error) { message = error instanceof Error ? error.message : "日程調整を読み込めませんでした。"; }
  }
  async function addScheduleOption() {
    try { await Promise.all(scheduleDraftDates.map((date) => api(`/events/${selectedEventId}/schedule/options`, { method: "POST", body: JSON.stringify({ date, note: scheduleNote || undefined }) }))); scheduleDraftDates = []; scheduleNote = ""; await loadSchedule(selectedEventId); }
    catch (error) { message = error instanceof Error ? error.message : "候補日時を追加できませんでした。"; }
  }
  function addInitialScheduleOption() { initialScheduleOptions = [...initialScheduleOptions, { date: "", note: "" }]; }
  function setSchedulingEnabled(enabled: boolean) { schedulingEnabled = enabled; if (enabled && initialScheduleOptions.length === 0) initialScheduleOptions = []; }
  function removeInitialScheduleOption(index: number) { initialScheduleOptions = initialScheduleOptions.filter((_, optionIndex) => optionIndex !== index); }
  function updateInitialScheduleOption(index: number, key: "date" | "note", value: string) {
    initialScheduleOptions = initialScheduleOptions.map((option, optionIndex) => optionIndex === index ? { ...option, [key]: value } : option);
  }
  function scheduleOptionLabel(option: { date: string }) { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "full" }).format(new Date(`${option.date}T00:00:00`)); }
  async function confirmSchedule(optionId: string) {
    try { await api(`/events/${selectedEventId}/schedule/confirm`, { method: "POST", body: JSON.stringify({ optionId }) }); await loadEvents(); await loadSchedule(selectedEventId); message = "日程を確定しました。"; }
    catch (error) { message = error instanceof Error ? error.message : "日程を確定できませんでした。"; }
  }
  async function initializeOrganizer() {
    try {
      const status = await fetch("/api/setup/status", { credentials: "same-origin" });
      const setup = await status.json();
      if (setup.initialSetupRequired) { initialSetupRequired = true; screen = "setup"; return; }
      const session = await api("/session");
      organizationId = session.organizationId; isAdministrator = session.role === "owner" || session.role === "admin";
      workspaceReady = true; screen = "home"; await Promise.all([loadEvents(), loadProfile()]);
    } catch { screen = "setup"; setupMessage = "Passkey でログインしてください。"; }
  }
  async function registerInitialAdministrator() {
    try {
      if (!administratorName.trim()) throw new Error("お名前を入力してください。");
      if (!window.PublicKeyCredential) throw new Error("この端末は Passkey に対応していません。");
      setupMessage = "Passkey を登録しています…";
      const optionsResponse = await fetch("/api/setup/initial-admin/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: administratorName.trim(), email: administratorEmail.trim() || undefined, avatarUrl: administratorAvatarUrl || undefined }) });
      const optionBody = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(optionBody.message ?? optionBody.error ?? "初期設定に失敗しました。");
      const credential = await startRegistration({ optionsJSON: optionBody.options });
      const response = await fetch("/api/setup/initial-admin/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: optionBody.challengeId, response: credential }) });
      const session = await response.json();
      if (!response.ok) throw new Error(session.message ?? session.error ?? "初期設定に失敗しました。");
      isAdministrator = true; workspaceReady = true; screen = "home";
      await Promise.all([loadEvents(), loadProfile()]); message = "初期管理者を登録しました。まずはイベントを作成しましょう。";
    } catch (error) { setupMessage = error instanceof Error ? error.message : "Passkey を登録できませんでした。"; }
  }
  function openEvent(eventId: string) { selectedEventId = eventId; screen = "event"; void selectEvent(eventId); }
  async function signIn() {
    try {
      if (!window.PublicKeyCredential) throw new Error("この端末は Passkey に対応していません。");
      setupMessage = "Passkey を確認しています…";
      const optionsResponse = await fetch("/api/session/options", { method: "POST", credentials: "same-origin" });
      const optionBody = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(optionBody.message ?? optionBody.error ?? "ログインを開始できません。");
      const credential = await startAuthentication({ optionsJSON: optionBody.options });
      const response = await fetch("/api/session/verify", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: optionBody.challengeId, response: credential }) });
      const session = await response.json();
      if (!response.ok) throw new Error(session.message ?? session.error ?? "Passkey を確認できませんでした。");
      organizationId = session.organizationId ?? organizationId; isAdministrator = session.role === "owner" || session.role === "admin";
      workspaceReady = true; screen = "home"; await Promise.all([loadEvents(), loadProfile()]);
    } catch (error) { setupMessage = error instanceof Error ? error.message : "Passkey でログインできませんでした。"; }
  }
  async function signOut() { await fetch("/api/session/logout", { method: "POST", credentials: "same-origin" }); workspaceReady = false; isAdministrator = false; events = []; screen = "setup"; setupMessage = "Passkey でログインしてください。"; }
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
      const url = new URL(ticketLink);
      const directTicket = url.pathname.match(/^\/public\/tickets\/([^/]+)\/check-in\/([^/]+)$/);
      const result = directTicket
        ? await api(`/tickets/${directTicket[1]}/check-in`, { method: "POST", body: JSON.stringify({ ticketToken: directTicket[2] }) })
        : await api("/tickets/check-in-link", { method: "POST", body: JSON.stringify({ linkToken: url.pathname.split("/").filter(Boolean).at(-1) }) });
      checkinMessage = result.outcome === "accepted" ? "受付が完了しました。" : `受付できません: ${result.outcome}`;
    } catch (error) { checkinMessage = error instanceof Error ? error.message : "受付に失敗しました。"; }
  }
  async function loadMetrics(eventId: string) {
    try { selectedEventId = eventId; metrics = await api(`/events/${eventId}/metrics`); }
    catch (error) { message = error instanceof Error ? error.message : "集計を読み込めませんでした。"; }
  }
  async function loadRoster(eventId: string) {
    try { const roster = await api(`/events/${eventId}/roster`); rosterFields = roster.fields; rosterAttendees = roster.attendees; }
    catch (error) { message = error instanceof Error ? error.message : "名簿を読み込めませんでした。"; }
  }
  async function loadOrganizers(eventId: string) {
    try {
      const [eventOrganizers, members] = await Promise.all([api(`/events/${eventId}/organizers`), organizationId ? api(`/organizations/${organizationId}/members`) : Promise.resolve({ members: [] })]);
      organizers = eventOrganizers.organizers; organizationMembers = members.members;
    } catch { organizers = []; organizationMembers = []; }
  }
  async function addCohost() { try { if (!selectedCohostId) return; await api(`/events/${selectedEventId}/organizers`, { method: "POST", body: JSON.stringify({ userId: selectedCohostId, role: "cohost" }) }); selectedCohostId = ""; await loadOrganizers(selectedEventId); } catch (error) { message = error instanceof Error ? error.message : "共同主催者を追加できませんでした。"; } }
  async function removeOrganizer(userId: string) { try { await api(`/events/${selectedEventId}/organizers/${userId}`, { method: "DELETE" }); await loadOrganizers(selectedEventId); } catch (error) { message = error instanceof Error ? error.message : "運営メンバーを変更できませんでした。"; } }
  async function sendAnnouncement() { try { const result = await api(`/events/${selectedEventId}/announcements`, { method: "POST", body: JSON.stringify({ subject: announcementSubject, message: announcementBody }) }); announcementSubject = ""; announcementBody = ""; announcementMessage = `${result.queued} 名へ案内を送信しました。`; } catch (error) { announcementMessage = error instanceof Error ? error.message : "案内を送信できませんでした。"; } }
  async function loadProfile() { try { const profile = await api("/profile"); profileName = profile.display_name ?? ""; profileEmail = profile.email_normalized ?? ""; profileAvatarUrl = profile.avatar_url ?? ""; } catch { /* no active organizer session */ } }
  async function saveProfile() { try { await api("/profile", { method: "PATCH", body: JSON.stringify({ displayName: profileName, email: profileEmail || undefined, avatarUrl: profileAvatarUrl || null }) }); profileMessage = "プロフィールを保存しました。"; } catch (error) { profileMessage = error instanceof Error ? error.message : "プロフィールを保存できませんでした。"; } }
  async function publishEvent(eventId: string) { try { await api(`/events/${eventId}/publish`, { method: "POST" }); await loadEvents(); message = "イベントを公開しました。"; } catch (error) { message = error instanceof Error ? error.message : "イベントを公開できませんでした。"; } }
  async function closeEvent(eventId: string) { try { await api(`/events/${eventId}/close`, { method: "POST" }); await loadEvents(); message = "イベントを終了しました。"; } catch (error) { message = error instanceof Error ? error.message : "イベントを終了できませんでした。"; } }
  async function removeEvent(eventId: string, canDelete: boolean) {
    const action = canDelete ? "この下書きイベントを完全に削除します。日程候補やフォーム設定も元に戻せません。" : "このイベントをアーカイブします。申込・受付を停止し、通常の一覧から非表示にします。";
    if (!window.confirm(action)) return;
    try {
      const result = await api(`/events/${eventId}`, { method: "DELETE" });
      screen = "home"; selectedEventId = ""; await loadEvents(); message = result.action === "deleted" ? "下書きイベントを削除しました。" : "イベントをアーカイブしました。";
    } catch (error) { message = error instanceof Error ? error.message : "イベントを処理できませんでした。"; }
  }
  async function selectEvent(eventId: string) { await Promise.all([loadMetrics(eventId), loadRoster(eventId), loadSchedule(eventId), loadOrganizers(eventId)]); }
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
  async function loadPublicSchedule() {
    try { const response = await fetch(`/public/events/${scheduleEventId}/schedule`); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); publicSchedule = body; }
    catch { scheduleResponseMessage = "この日程調整は利用できません。"; }
  }
  async function submitScheduleResponse(optionId: string, responseValue: string) {
    try {
      const response = await fetch(`/public/events/${scheduleEventId}/schedule/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId, response: responseValue, respondentId: scheduleRespondentId, respondentName: scheduleRespondentName }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); scheduleResponses = { ...scheduleResponses, [optionId]: responseValue }; scheduleResponseMessage = "回答を保存しました。"; await loadPublicSchedule();
    } catch (error) { scheduleResponseMessage = error instanceof Error ? error.message : "回答を保存できませんでした。"; }
  }
  async function createAgentConnection() {
    try {
      const response = await fetch(`/public/events/${scheduleEventId}/schedule/agent-connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: scheduleRespondentId, respondentName: scheduleRespondentName }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); agentConnection = body; await loadAgentConnections(); scheduleResponseMessage = "AI 連携用トークンを発行しました。";
    } catch (error) { scheduleResponseMessage = error instanceof Error ? error.message : "AI 連携を開始できませんでした。"; }
  }
  async function loadAgentConnections() {
    try { const response = await fetch(`/public/events/${scheduleEventId}/schedule/agent-connections?respondentId=${encodeURIComponent(scheduleRespondentId)}`); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); agentConnections = body.connections; }
    catch (error) { scheduleResponseMessage = error instanceof Error ? error.message : "AI 連携の状態を取得できませんでした。"; }
  }
  async function revokeAgentConnection(connectionId: string) {
    try { const response = await fetch(`/public/events/${scheduleEventId}/schedule/agent-connections/${connectionId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: scheduleRespondentId }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); await loadAgentConnections(); scheduleResponseMessage = "AI 連携を解除しました。"; }
    catch (error) { scheduleResponseMessage = error instanceof Error ? error.message : "AI 連携を解除できませんでした。"; }
  }
  async function register() {
    try { const response = await fetch(`/public/events/${registrationEventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: registrationName, email: registrationEmail || undefined, answers: registrationAnswers }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); issuedTicket = { id: body.ticketId, token: body.ticketToken }; ticketQr = await QRCode.toDataURL(`${window.location.origin}/public/tickets/${body.ticketId}/check-in/${body.ticketToken}`, { errorCorrectionLevel: "M", margin: 1, width: 640 }); registrationMessage = body.emailQueued ? "申込を受け付け、QRチケットをメールで送付しました。" : "申込を受け付けました。チケットはこの画面から離れる前に保存してください。"; }
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
  function answerText(value: unknown) { return Array.isArray(value) ? value.join(", ") : value === true ? "Yes" : value === false ? "No" : typeof value === "string" || typeof value === "number" ? String(value) : ""; }
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
{:else if scheduleEventId}
  <header><p class="eyebrow">SCHEDULE POLL</p><h1>tsudoi</h1><p>{publicSchedule?.event.name ?? "日程調整"}</p></header>
  {#if publicSchedule}
    <section><h2>{publicSchedule.event.name} の日程調整</h2><p>{publicSchedule.event.description}</p>
      {#if publicSchedule.event.schedule_status === "confirmed"}<p class="notice">日程は確定しています。</p>{:else}
        <label>お名前<input bind:value={scheduleRespondentName} required placeholder="山田太郎" /></label>
        <p class="muted">候補ごとに参加可否を選んでください。</p>
        <div class="schedule-list">{#each publicSchedule.options as option}<div class="schedule-option"><div><strong>{scheduleOptionLabel(option)}</strong>{#if option.note}<p class="muted">{option.note}</p>{/if}<p class="muted">○ {option.yes ?? 0}　△ {option.maybe ?? 0}　× {option.no ?? 0}</p></div><div class="response-buttons"><button class:chosen={scheduleResponses[option.id] === "yes"} disabled={!scheduleRespondentName.trim()} onclick={() => void submitScheduleResponse(option.id, "yes")}>○ 参加</button><button class:chosen={scheduleResponses[option.id] === "maybe"} disabled={!scheduleRespondentName.trim()} onclick={() => void submitScheduleResponse(option.id, "maybe")}>△ 未定</button><button class:chosen={scheduleResponses[option.id] === "no"} disabled={!scheduleRespondentName.trim()} onclick={() => void submitScheduleResponse(option.id, "no")}>× 不参加</button></div></div>{/each}</div>
        <section class="schedule-form"><h3>AI に日程調整を任せる</h3><p class="muted">カレンダー連携済みのAIに、このイベントの候補確認とあなた自身の可否回答だけを許可します。候補が増えた場合もAIは再確認できます。</p><button disabled={!scheduleRespondentName.trim()} onclick={() => void createAgentConnection()}>AI連携用トークンを発行</button><button class="quiet" disabled={!scheduleRespondentName.trim()} onclick={() => void loadAgentConnections()}>接続を確認</button>{#if agentConnection}<p class="notice">このトークンは一度だけ表示されます。AIのMCP接続設定に登録してください。</p><label>MCP URL<input readonly value={agentConnection.mcpUrl} /></label><label>アクセストークン<input readonly value={agentConnection.token} /></label><p class="muted">有効期限: {agentConnection.expiresInDays} 日。日程確定後は可否の変更が自動で停止します。</p>{/if}{#if agentConnections.length > 0}<h4>AI連携</h4><ul>{#each agentConnections as connection}<li><span>{connection.revoked_at ? "解除済み" : `有効（${connection.expires_at}まで）`}</span>{#if !connection.revoked_at}<button class="quiet" onclick={() => void revokeAgentConnection(connection.id)}>解除</button>{/if}</li>{/each}</ul>{/if}</section>
      {/if}
    </section>
  {:else}<p class="notice" aria-live="polite">{scheduleResponseMessage}</p>{/if}
  {#if scheduleResponseMessage}<p class="notice" aria-live="polite">{scheduleResponseMessage}</p>{/if}
{:else if registrationEventId}
  <header><p class="eyebrow">EVENT REGISTRATION</p><h1>tsudoi</h1><p>{publicEvent?.name ?? "申込フォーム"}</p></header>
  {#if publicEvent}<section><h2>{publicEvent.name}</h2><p>{publicEvent.description}</p><p>{publicEvent.starts_at}</p><form onsubmit={(event) => { event.preventDefault(); void register(); }}><label>氏名<input bind:value={registrationName} required /></label><label>メールアドレス<input bind:value={registrationEmail} type="email" /></label>{#each publicFields as field}{#if field.field_type === "multi_select"}<fieldset><legend>{field.label}{#if field.required === 1}（必須）{/if}</legend>{#each options(field) as option}<label class="inline"><input type="checkbox" checked={selectedAnswer(field.field_key, option)} onchange={(event) => toggleSelectedAnswer(field.field_key, option, event.currentTarget.checked)} />{option}</label>{/each}</fieldset>{:else if field.field_type === "checkbox" || field.field_type === "consent"}<label class="inline"><input type="checkbox" checked={checkedAnswer(field.field_key)} onchange={(event) => setCheckedAnswer(field.field_key, event.currentTarget.checked)} required={field.required === 1} />{field.label}</label>{:else}<label>{field.label}{#if field.field_type === "textarea"}<textarea value={stringAnswer(field.field_key)} oninput={(event) => setStringAnswer(field.field_key, event.currentTarget.value)} required={field.required === 1}></textarea>{:else if field.field_type === "single_select"}<select value={stringAnswer(field.field_key)} onchange={(event) => setStringAnswer(field.field_key, event.currentTarget.value)} required={field.required === 1}><option value="">選択してください</option>{#each options(field) as option}<option value={option}>{option}</option>{/each}</select>{:else}<input value={stringAnswer(field.field_key)} oninput={(event) => setStringAnswer(field.field_key, event.currentTarget.value)} required={field.required === 1} type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : "text"} />{/if}</label>{/if}{/each}<button>申し込む</button></form></section>{/if}
  {#if registrationMessage}<p class="notice" aria-live="polite">{registrationMessage}</p>{/if}
  {#if ticketQr}<section aria-labelledby="ticket-qr"><h2 id="ticket-qr">あなたの受付QR</h2><p>会場で提示してください。安全のため、他者へ転送しないでください。</p><img src={ticketQr} alt="受付用QRコード" width="320" height="320" /></section>{/if}
  {#if issuedTicket}<section aria-labelledby="passkey-registration"><h2 id="passkey-registration">Passkey を登録する</h2><p>この端末でチケットを安全に再表示できるようにします。PRF対応Passkeyでは、E2EE鍵の保護にも使用します。</p><button onclick={registerPasskey}>Passkey を登録</button>{#if passkeyMessage}<p class="notice" aria-live="polite">{passkeyMessage}</p>{/if}</section>{/if}
{:else}
  {#if !workspaceReady || screen === "setup"}
    <header><p class="eyebrow">WELCOME TO TSUDOI</p><h1>tsudoi</h1><p>{initialSetupRequired ? "最初に、初期管理者を登録します。" : "Passkey でログインします。"}</p></header>
    <section class="focus-card" aria-labelledby="initial-admin"><h2 id="initial-admin">{initialSetupRequired ? "初期管理者の Passkey を登録" : "Passkey でログイン"}</h2>
      {#if initialSetupRequired}<p>この端末の Passkey で管理を始めます。イベントごとに主催者・共同主催者を設定できます。</p>
        <label>お名前<input bind:value={administratorName} autocomplete="name" placeholder="例: 山田 太郎" required /></label>
        <div class="avatar-setup"><img src={administratorAvatarUrl || identiconUrl(administratorName)} alt="プロフィール画像のプレビュー" /><div><label>プロフィール画像（任意）<input accept="image/png,image/jpeg,image/webp" onchange={(event) => void selectAdministratorAvatar(event.currentTarget.files?.[0])} type="file" /></label><p class="muted">未設定時は名前から作る Identicon を使います。PNG・JPEG・WebP、200KB以下。</p>{#if administratorAvatarUrl}<button type="button" class="quiet" onclick={() => administratorAvatarUrl = ""}>画像を外す</button>{/if}</div></div>
        <label>メールアドレス（任意・非公開）<input bind:value={administratorEmail} autocomplete="email" type="email" placeholder="通知・復旧用" /></label>
        <button onclick={registerInitialAdministrator}>Passkey を登録して始める</button>
      {:else}<p>登録済みの Passkey を使って管理画面を開きます。</p><button onclick={signIn}>Passkey でログイン</button>{/if}
      <p class="notice" aria-live="polite">{setupMessage}</p>
    </section>
  {:else}
    <header class="app-header"><div><p class="eyebrow">EVENT ROSTER</p><h1>tsudoi</h1></div><nav aria-label="管理ナビゲーション">
      {#if screen !== "home"}<button class="quiet" onclick={() => screen = "home"}>イベント</button>{/if}
      {#if isAdministrator}<button class="quiet" onclick={() => screen = "admin"}>管理メニュー</button>{/if}
    </nav></header>
    {#if screen === "home"}
      <p class="notice" aria-live="polite">{message}</p>
      <section class="focus-card" aria-labelledby="new-event"><h2 id="new-event">新しいイベントを作成</h2>
        <p>イベント名だけで作成できます。日時が決まっていない場合は、日程調整を使えます。</p>
    <form onsubmit={(event) => { event.preventDefault(); void createEvent(); }}>
      <label>イベント名<input bind:value={eventName} required /></label>
      <label class="inline"><input checked={schedulingEnabled} onchange={(event) => setSchedulingEnabled(event.currentTarget.checked)} type="checkbox" />日程を調整する</label>
      {#if schedulingEnabled}
        <fieldset class="schedule-form"><legend>最初の候補日</legend><p class="muted">カレンダーから参加できそうな日を選んでください。時刻は日程確定後に連絡します。</p>
          <div class="calendar-head"><button type="button" class="quiet" aria-label="前月" onclick={() => moveCalendarMonth(-1)}>‹</button><strong>{monthLabel(calendarMonth)}</strong><button type="button" class="quiet" aria-label="翌月" onclick={() => moveCalendarMonth(1)}>›</button></div>
          <div class="calendar-grid" role="group" aria-label="候補日を選択">{#each ["日", "月", "火", "水", "木", "金", "土"] as weekday}<span class="calendar-weekday">{weekday}</span>{/each}{#each calendarDays(calendarMonth) as date}<div class="calendar-cell">{#if date}<button type="button" class:chosen={initialScheduleOptions.some((option) => option.date === date)} onclick={() => toggleInitialDate(date)}>{Number(date.slice(-2))}</button>{/if}</div>{/each}</div>
          {#if initialScheduleOptions.length === 0}<p class="muted">候補日を2日以上選ぶと比較しやすくなります。</p>{:else}<div class="selected-dates">{#each initialScheduleOptions as option, index}<div><strong>{scheduleOptionLabel(option)}</strong><label>メモ（任意）<input value={option.note} oninput={(event) => updateInitialScheduleOption(index, "note", event.currentTarget.value)} placeholder="会場の都合など" /></label><button type="button" class="quiet" onclick={() => removeInitialScheduleOption(index)}>外す</button></div>{/each}</div>{/if}
        </fieldset>
      {:else}<label>開始日時<input bind:value={startsAt} type="datetime-local" step="900" required /></label>{/if}
      <button>作成する</button>
    </form>
      </section>
      <section aria-labelledby="events"><h2 id="events">あなたのイベント</h2>
        {#if events.length === 0}<p>まだイベントがありません。</p>{:else}<ul>{#each events as event}<li><div><strong>{event.name}</strong><p class="muted">{event.scheduling_enabled === 1 && event.schedule_status !== "confirmed" ? "日程調整中" : `${event.starts_at} · ${event.status}`}</p></div><button onclick={() => openEvent(event.id)}>管理する</button></li>{/each}</ul>{/if}
      </section>
    {:else if screen === "admin"}
      <section aria-labelledby="admin-menu"><h2 id="admin-menu">プロフィール</h2><p>表示名はイベントの運営メンバー表示に使われます。メールアドレスは非公開です。</p>
        <div class="avatar-setup"><img src={profileAvatarUrl || identiconUrl(profileName)} alt="プロフィール画像のプレビュー" /><div><label>プロフィール画像（任意）<input accept="image/png,image/jpeg,image/webp" onchange={(event) => void selectProfileAvatar(event.currentTarget.files?.[0])} type="file" /></label>{#if profileAvatarUrl}<button type="button" class="quiet" onclick={() => profileAvatarUrl = ""}>画像を外す</button>{/if}</div></div>
        <label>お名前<input bind:value={profileName} required /></label><label>メールアドレス（任意・非公開）<input bind:value={profileEmail} type="email" /></label><button onclick={saveProfile}>保存する</button>{#if profileMessage}<p class="notice">{profileMessage}</p>{/if}
      </section>
      <section aria-labelledby="admin-session"><h2 id="admin-session">ログイン</h2><p>この端末のログイン状態を管理します。</p>
        <button onclick={signOut}>ログアウト</button>
      </section>
    {:else}
      <section class="event-title"><h2>{events.find((event) => event.id === selectedEventId)?.name ?? "イベント管理"}</h2><p>必要な作業を選んでください。</p></section>
      {#if schedule?.enabled && schedule.status !== "confirmed"}
        <section aria-labelledby="schedule-management"><h2 id="schedule-management">日程を調整</h2><p>候補日を選んで、参加者に回答してもらいます。</p>
          <p class="muted">共有用URL: <a href={`/events/${selectedEventId}/schedule`} target="_blank" rel="noreferrer">日程調整ページを開く</a></p>
          <form onsubmit={(event) => { event.preventDefault(); void addScheduleOption(); }} class="schedule-form"><div class="calendar-head"><button type="button" class="quiet" aria-label="前月" onclick={() => moveCalendarMonth(-1)}>‹</button><strong>{monthLabel(calendarMonth)}</strong><button type="button" class="quiet" aria-label="翌月" onclick={() => moveCalendarMonth(1)}>›</button></div><div class="calendar-grid">{#each ["日", "月", "火", "水", "木", "金", "土"] as weekday}<span class="calendar-weekday">{weekday}</span>{/each}{#each calendarDays(calendarMonth) as date}<div class="calendar-cell">{#if date}<button type="button" class:chosen={scheduleDraftDates.includes(date)} onclick={() => toggleScheduleDraftDate(date)}>{Number(date.slice(-2))}</button>{/if}</div>{/each}</div><label>メモ（任意・選んだ日すべてに付与）<input bind:value={scheduleNote} placeholder="会場の都合など" /></label><button disabled={scheduleDraftDates.length === 0}>選んだ {scheduleDraftDates.length} 日を候補に追加</button></form>
          {#if schedule.options.length === 0}<p>候補日を追加してください。</p>{:else}<div class="schedule-list">{#each schedule.options as option}<div class="schedule-option"><div><strong>{scheduleOptionLabel(option)}</strong>{#if option.note}<p class="muted">{option.note}</p>{/if}<p class="muted">○ {option.yes ?? 0}　△ {option.maybe ?? 0}　× {option.no ?? 0}</p></div>{#if isAdministrator}<button onclick={() => void confirmSchedule(option.id)}>この日に確定</button>{/if}</div>{/each}</div>{/if}
        </section>
      {:else if schedule?.enabled}
        <section class="notice"><strong>日程確定済み</strong><p>{schedule.date ? scheduleOptionLabel({ date: schedule.date }) : ""}</p><p class="muted">時刻は参加者へ別途ご連絡ください。</p></section>
      {/if}
      {#if schedule?.enabled && schedule.status === "confirmed"}<section aria-labelledby="announcement"><h2 id="announcement">参加者へ案内</h2><p>確定した日程や、時刻・場所の連絡をメールでまとめて送れます。</p><form onsubmit={(event) => { event.preventDefault(); void sendAnnouncement(); }}><label>件名<input bind:value={announcementSubject} placeholder="集合時刻と場所のご案内" required /></label><label>本文<textarea bind:value={announcementBody} placeholder="確定日、集合時刻、場所、持ち物など" required></textarea></label><button>参加者へ送信</button></form>{#if announcementMessage}<p class="notice">{announcementMessage}</p>{/if}</section>{/if}
      <div class="management-grid"><a href="#roster">名簿を管理</a><a href="#check-in">QR 受付</a><a href="#settings">申込フォーム設定</a></div>
      {#if isAdministrator}
        {@const currentEvent = events.find((event) => event.id === selectedEventId)}
        {#if currentEvent?.status === "draft"}<button class="quiet action" onclick={() => publishEvent(selectedEventId)}>イベントを公開する</button>{:else if currentEvent?.status === "published"}<button class="quiet action" onclick={() => closeEvent(selectedEventId)}>イベントを終了する</button>{/if}
        {#if currentEvent}<button class="quiet action" onclick={() => removeEvent(selectedEventId, currentEvent.status === "draft" && (metrics?.registrations ?? 0) === 0)}>{currentEvent.status === "draft" && (metrics?.registrations ?? 0) === 0 ? "下書きを削除する" : "イベントをアーカイブする"}</button>{/if}
      {/if}
      {#if isAdministrator}<section aria-labelledby="organizers"><h2 id="organizers">運営メンバー</h2><p>主催者と共同主催者を確認・追加できます。</p><ul>{#each organizers as organizer}<li><div><strong>{organizer.display_name || "名称未設定"}</strong><span>{organizer.role === "organizer" ? "主催者" : "共同主催者"}</span></div><button class="quiet" onclick={() => void removeOrganizer(organizer.user_id)}>外す</button></li>{/each}</ul><form onsubmit={(event) => { event.preventDefault(); void addCohost(); }}><label>共同主催者<select bind:value={selectedCohostId}><option value="">選択してください</option>{#each organizationMembers.filter((member) => !organizers.some((organizer) => organizer.user_id === member.id)) as member}<option value={member.id}>{member.display_name || member.email_normalized || member.id}</option>{/each}</select></label><button disabled={!selectedCohostId}>追加する</button></form></section>{/if}
      {#if isAdministrator}{@const checklistEvent = events.find((event) => event.id === selectedEventId)}<section aria-labelledby="publish-check"><h2 id="publish-check">公開前チェック</h2><ul class="checklist"><li class:complete={Boolean(checklistEvent?.name)}>イベント名</li><li class:complete={!checklistEvent?.scheduling_enabled || schedule?.status === "confirmed"}>日程{checklistEvent?.scheduling_enabled ? "を確定" : "を設定"}</li><li class:complete={rosterFields.length > 0}>申込項目（任意）</li><li class:complete={checklistEvent?.status === "published"}>公開</li></ul></section>{/if}
      {#if metrics}
        <section aria-labelledby="metrics"><h2 id="metrics">受付状況</h2>
      <dl class="metrics"><div><dt>申込</dt><dd>{metrics.registrations ?? 0}</dd></div><div><dt>発券</dt><dd>{metrics.issued ?? 0}</dd></div><div><dt>取消</dt><dd>{metrics.cancelled ?? 0}</dd></div><div><dt>受付済</dt><dd>{metrics.checked_in ?? 0}</dd></div><div><dt>未受付</dt><dd>{metrics.not_checked_in ?? 0}</dd></div></dl>
        </section>
      {/if}
      <section aria-labelledby="roster"><h2 id="roster">名簿を管理</h2><p class="muted">申込者と受付状態を確認できます。</p>
      {#if rosterAttendees.length === 0}<p>登録者はいません。</p>{:else}<div class="table-scroll"><table><thead><tr><th>氏名</th><th>メール</th><th>チケット</th>{#each rosterFields as field}<th>{field.label}</th>{/each}</tr></thead><tbody>{#each rosterAttendees as attendee}<tr><td>{attendee.name}</td><td>{attendee.email_normalized ?? ""}</td><td>{attendee.ticket_status}</td>{#each rosterFields as field}<td>{answerText(attendee.answers[field.field_key])}</td>{/each}</tr>{/each}</tbody></table></div>{/if}
      </section>
      <section id="settings" aria-labelledby="custom-fields"><h2 id="custom-fields">申込フォーム設定</h2>
      <form onsubmit={(event) => { event.preventDefault(); void createField(); }}>
        <label>項目キー<input bind:value={fieldKey} pattern={fieldKeyPattern} placeholder="company_name" required /></label>
        <label>表示名<input bind:value={fieldLabel} placeholder="所属" required /></label>
        <label>型<select bind:value={fieldType}><option value="text">短文</option><option value="textarea">長文</option><option value="number">数値</option><option value="date">日付</option><option value="single_select">単一選択</option><option value="multi_select">複数選択</option><option value="checkbox">チェックボックス</option><option value="consent">同意</option></select></label>
        {#if fieldType === "single_select" || fieldType === "multi_select"}<label>選択肢（改行またはカンマ区切り）<textarea bind:value={fieldOptions} required></textarea></label>{/if}
        <label class="inline"><input bind:checked={fieldRequired} type="checkbox" />必須項目</label><button>項目を追加</button>
      </form>
      {#if fieldMessage}<p class="notice" aria-live="polite">{fieldMessage}</p>{/if}
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
  {/if}
{/if}
</main>
