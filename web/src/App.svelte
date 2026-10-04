<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
  import QRCode from "qrcode";
  import FieldInputs from "./lib/FieldInputs.svelte";
  import type { FormAnswers, FormField } from "./lib/form-fields";

  type ParticipantTicket = { id: string; status: string; event_name: string; starts_at: string; ends_at: string; timezone: string; venue_name: string | null; cancellation_closes_at: string | null };
  let administratorName = "";
  let administratorEmail = "";
  let administratorAvatarUrl = "";
  let organizationId = "";
  let profileName = "";
  let profileEmail = "";
  let profileAvatarUrl = "";
  let profileMessage = "";
  let apiTokens: Array<{ id: string; label: string; scopes: string[]; expires_at: string | null; revoked_at: string | null }> = [];
  let newTokenLabel = "";
  let newTokenScope = "roster:read";
  let newTokenValue = "";
  let inviteEmail = "";
  let inviteRole = "staff";
  let inviteUrl = "";
  let inviteDisplayName = "";
  let inviteInfo: { organizationName: string; role: string; email: string | null } | null = null;
  let inviteMessage = "招待を確認しています。";
  let initialSetupRequired = false;
  let workspaceReady = false;
  let isAdministrator = false;
  let currentRole = "";
  let checkinBusy = false;
  let lastCheckinBy = "";
  let editingAttendeeId = "";
  let editName = "";
  let editAffiliation = "";
  let editVenueId = "";
  let editAnswers: FormAnswers = {};
  let editRevision = 0;
  let editMessage = "";
  let csvColumns: string[] = [];
  let csvRows: string[][] = [];
  let csvMapping: Record<string, string> = {};
  let csvPreview: { previewToken: string; columns: string[]; rows: Array<{ rowIndex: number; values: string[]; duplicateCandidates: Array<{ attendeeId: string; name: string; email: string | null; affiliation?: string | null; venueName?: string | null }>; errors: string[] }>; validCount: number } | null = null;
  let csvDecisions: Array<"include" | "skip"> = [];
  let csvMessage = "";
  let screen: "setup" | "home" | "event" | "admin" = "setup";
  let setupMessage = "この tsudoi を使い始めるには、初期管理者の Passkey を登録してください。";
  let events: Array<{ id: string; name: string; starts_at: string; ends_at: string; status: string; scheduling_enabled?: number; schedule_status?: string }> = [];
  let message = "イベントを読み込んでいます。";
  let eventName = "";
  let eventDate = "";
  let eventCapacity = "";
  let registrationOpensAt = "";
  let registrationClosesAt = "";
  let schedulingEnabled = false;
  let initialScheduleOptions: Array<{ date: string; note: string }> = [];
  let scheduleDraftDates: string[] = [];
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let ticketLink = "";
  let checkinMessage = "";
  let ticketLinkMessage = "";
  let scannerActive = false;
  let scannerLatchedValue = "";
  let scannerVideo: HTMLVideoElement;
  let scannerStream: MediaStream | null = null;
  let venues: Array<{ id: string; name: string; address: string }> = [];
  let selectedVenueId = "";
  let newVenueName = "";
  let walkInName = "";
  let walkInEmail = "";
  let walkInQr = "";
  let walkInFields: FormField[] = [];
  let walkInAnswers: FormAnswers = {};
  let walkInFieldsReady = false;
  let walkInFieldMessage = "";
  let walkInSaving = false;
  let selectedStaffId = "";
  let selectedEventId = "";
  let schedule: { enabled: boolean; status: string; date: string | null; startsAt?: string | null; endsAt?: string | null; allDay?: boolean; timeZone?: string; readyToConfirm?: string[]; participants?: Array<{ displayName: string; role: string; answered: boolean }>; options: Array<{ id: string; date: string; note: string; yes: number; maybe: number; no: number; start?: string | null; end?: string | null; allDay?: boolean }> } | null = null;
  let scheduleInviteUrl = "";
  let scheduleDate = "";
  let scheduleNote = "";
  let metrics: { registrations: number; issued: number; cancelled: number; checked_in: number; not_checked_in: number } | null = null;
  let rosterFields: Array<{ field_key: string; label: string }> = [];
  let rosterReady = false;
  let rosterAttendees: Array<{ id: string; ticket_id: string; name: string; email_normalized: string | null; ticket_status: string; answers: Record<string, string | number | boolean | string[] | null>; affiliation?: string | null; venue_id?: string | null; revision?: number; checked_in_by_display_name?: string | null }> = [];
  let confirmAttendee: typeof rosterAttendees[number] | null = null;
  let rosterQuery = "";
  let rosterStatus = "";
  let rosterSource = "";
  let rosterVenueId = "";
  let rosterCursor: string | null = null;
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
  let publicFields: FormField[] = [];
  let registrationName = ""; let registrationEmail = ""; let registrationAnswers: FormAnswers = {}; let registrationMessage = "";
  let turnstileSiteKey = "";
  let turnstileToken = "";
  let publicSchedule: { event: { name: string; description: string; timezone: string; schedule_status: string }; options: Array<{ id: string; date: string; note: string; yes: number; maybe: number; no: number; start?: string | null; end?: string | null; allDay?: boolean }> } | null = null;
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
  let participantQr = "";
  const ticketPage = typeof window !== "undefined" && window.location.pathname === "/ticket";
  const mcpUrl = typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";
  const inviteToken = typeof window !== "undefined" ? window.location.pathname.match(/^\/invite\/([^/]+)$/)?.[1] ?? "" : "";

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
    if (inviteToken) void loadInvite();
    else if (ticketPage) void loadParticipantTicket();
    else if (registrationEventId) void loadRegistration();
    else if (scheduleEventId) { scheduleRespondentId = localStorage.getItem(`tsudoi-schedule-${scheduleEventId}`) ?? crypto.randomUUID(); localStorage.setItem(`tsudoi-schedule-${scheduleEventId}`, scheduleRespondentId); void loadPublicSchedule(); }
    else {
      void initializeOrganizer();
    }
  });
  onDestroy(() => stopScanner());

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`/api${path}`, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...init.headers } });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (body?.outcome === "duplicate") throw new Error(`受付済みです。最初の受付: ${body.ticket?.checked_in_at ?? "時刻不明"} / 担当: ${body.ticket?.checked_in_by_display_name || "不明"}`);
      if (body?.outcome === "rejected") throw new Error("このチケットは取消済み、または無効です。");
      if (body?.error === "wrong_venue") throw new Error("この参加者の会場と受付会場が違います。受付会場を確認してください。");
      throw new Error(body.message ?? body.error ?? "リクエストに失敗しました");
    }
    return body;
  }
  async function loadEvents() {
    try { events = await api("/events"); message = `${events.length} 件のイベントを読み込みました。`; }
    catch (error) { message = error instanceof Error ? error.message : "読み込みに失敗しました。"; }
  }
  async function createEvent() {
    try {
      await api("/events", { method: "POST", body: JSON.stringify({ name: eventName, startsAt: schedulingEnabled ? undefined : eventDate, schedulingEnabled, initialScheduleOptions: schedulingEnabled ? initialScheduleOptions : undefined, registrationMode: "hybrid", capacity: eventCapacity ? Number(eventCapacity) : undefined, registrationOpensAt: registrationOpensAt || undefined, registrationClosesAt: registrationClosesAt || undefined }) });
      eventName = ""; eventDate = ""; eventCapacity = ""; registrationOpensAt = ""; registrationClosesAt = ""; schedulingEnabled = false; initialScheduleOptions = []; await loadEvents(); message = "イベントを作成しました。";
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
  function scheduleOptionLabel(option: { date: string; start?: string | null; end?: string | null; allDay?: boolean }) {
    if (option.allDay === false && option.start && option.end) {
      const zone = schedule?.timeZone ?? publicSchedule?.event.timezone ?? "Asia/Tokyo";
      const start = new Intl.DateTimeFormat("ja-JP", { dateStyle: "full", timeStyle: "short", timeZone: zone }).format(new Date(option.start));
      const end = new Intl.DateTimeFormat("ja-JP", { timeStyle: "short", timeZone: zone }).format(new Date(option.end));
      return `${start}–${end}`;
    }
    const parsed = new Date(`${option.date}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? option.date : new Intl.DateTimeFormat("ja-JP", { dateStyle: "full" }).format(parsed);
  }
  async function createScheduleInvite(role: "required" | "optional") {
    try { const created = await api(`/events/${selectedEventId}/schedule/invites`, { method: "POST", body: JSON.stringify({ role }) }); scheduleInviteUrl = created.url; message = role === "required" ? "必須参加者の招待リンクを発行しました。" : "任意参加者の招待リンクを発行しました。"; }
    catch (error) { message = error instanceof Error ? error.message : "招待リンクを発行できませんでした。"; }
  }
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
      organizationId = session.organizationId; currentRole = session.role; isAdministrator = session.role === "owner" || session.role === "admin";
      workspaceReady = true; screen = "home"; await Promise.all([loadEvents(), loadProfile(), loadApiTokens()]);
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
  function openEvent(eventId: string) { stopScanner(); csvColumns = []; csvRows = []; csvMapping = {}; csvPreview = null; csvDecisions = []; csvMessage = ""; confirmAttendee = null; editingAttendeeId = ""; editMessage = ""; checkinMessage = ""; ticketLinkMessage = ""; lastCheckinBy = ""; selectedEventId = eventId; screen = "event"; void selectEvent(eventId); }
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
      organizationId = session.organizationId ?? organizationId; currentRole = session.role; isAdministrator = session.role === "owner" || session.role === "admin";
      workspaceReady = true; screen = "home"; await Promise.all([loadEvents(), loadProfile()]);
    } catch (error) { setupMessage = error instanceof Error ? error.message : "Passkey でログインできませんでした。"; }
  }
  async function signOut() { stopScanner(); await fetch("/api/session/logout", { method: "POST", credentials: "same-origin" }); workspaceReady = false; isAdministrator = false; currentRole = ""; events = []; screen = "setup"; setupMessage = "Passkey でログインしてください。"; }
  function goHome() { stopScanner(); confirmAttendee = null; editingAttendeeId = ""; screen = "home"; }
  async function loadParticipantTicket() {
    try {
      const response = await fetch("/api/participant/ticket", { credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "ticket_not_found");
      participantTicket = body; participantMessage = "";
      participantQr = "";
      if (body.status === "issued") await refreshParticipantQr();
    } catch { participantMessage = "ログインが必要です。メールのリンクを開くか、Passkey でログインしてください。"; }
  }
  async function signInParticipant() {
    try {
      const optionsResponse = await fetch("/public/participant/passkeys/authentication/options", { method: "POST" });
      const optionBody = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(optionBody.error);
      const credential = await startAuthentication({ optionsJSON: optionBody.options });
      const response = await fetch("/public/participant/passkeys/authentication/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: optionBody.challengeId, response: credential }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await loadParticipantTicket();
    } catch (error) { participantMessage = error instanceof Error ? error.message : "Passkey でログインできませんでした。"; }
  }
  async function refreshParticipantQr() {
    try {
      const response = await fetch("/api/participant/ticket/qr", { method: "POST", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "QR を発行できませんでした。");
      participantQr = await QRCode.toDataURL(body.url, { errorCorrectionLevel: "M", margin: 1, width: 640 });
    } catch { participantMessage = "受付 QR を発行できませんでした。再読み込みしてください。"; }
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
    if (checkinBusy) return;
    checkinBusy = true;
    checkinMessage = "受付を確認しています…"; lastCheckinBy = "";
    try {
      const url = new URL(ticketLink);
      const directTicket = url.pathname.match(/^\/public\/tickets\/([^/]+)\/check-in\/([^/]+)$/);
      const result = directTicket
        ? await api(`/tickets/${directTicket[1]}/check-in`, { method: "POST", body: JSON.stringify({ ticketToken: directTicket[2], venueId: selectedVenueId || undefined }) })
        : await api("/tickets/check-in-link", { method: "POST", body: JSON.stringify({ linkToken: url.pathname.split("/").filter(Boolean).at(-1), venueId: selectedVenueId || undefined }) });
      checkinMessage = result.outcome === "accepted" ? "受付が完了しました。" : `受付できません: ${result.outcome}`;
      lastCheckinBy = result.ticket?.checked_in_by_display_name ?? result.checkedInByDisplayName ?? "";
      if (result.outcome === "accepted") await Promise.all([loadMetrics(selectedEventId), loadRoster(selectedEventId)]);
    } catch (error) { checkinMessage = error instanceof Error ? error.message : "受付に失敗しました。"; }
    finally { checkinBusy = false; }
  }
  async function startScanner() {
    const browser = window as Window & { BarcodeDetector?: new (options: { formats: string[] }) => { detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } };
    if (!browser.BarcodeDetector) { checkinMessage = "このブラウザーではカメラ読み取りに対応していません。QR のリンクを貼り付けてください。"; return; }
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      scannerActive = true;
      await tick();
      scannerVideo.srcObject = scannerStream;
      await scannerVideo.play();
      const detector = new browser.BarcodeDetector({ formats: ["qr_code"] });
      const scan = async () => {
        if (!scannerActive) return;
        try {
          const codes = await detector.detect(scannerVideo);
          const scanned = codes[0]?.rawValue ?? "";
          if (!scanned) scannerLatchedValue = "";
          else if (scanned !== scannerLatchedValue && !checkinBusy) { scannerLatchedValue = scanned; ticketLink = scanned; await checkInTicketLink(); }
        } catch { /* keep scanning */ }
        if (scannerActive) requestAnimationFrame(() => void scan());
      };
      void scan();
    } catch { stopScanner(); checkinMessage = "カメラを開けませんでした。QR のリンクを貼り付けてください。"; }
  }
  function stopScanner() {
    scannerActive = false;
    scannerLatchedValue = "";
    scannerStream?.getTracks().forEach((track) => track.stop());
    scannerStream = null;
    if (scannerVideo) scannerVideo.srcObject = null;
  }
  async function checkInAttendee(attendeeId: string) {
    if (checkinBusy) return;
    checkinBusy = true;
    lastCheckinBy = ""; checkinMessage = "受付を確認しています…";
    try { const result = await api(`/events/${selectedEventId}/attendees/${attendeeId}/check-in`, { method: "POST", body: JSON.stringify({ venueId: selectedVenueId || undefined }) }); checkinMessage = result.outcome === "accepted" ? "受付が完了しました。" : `受付できません: ${result.outcome}`; lastCheckinBy = result.ticket?.checked_in_by_display_name ?? result.checkedInByDisplayName ?? ""; await Promise.all([loadMetrics(selectedEventId), loadRoster(selectedEventId)]); }
    catch (error) { checkinMessage = error instanceof Error ? error.message : "受付に失敗しました。"; }
    finally { checkinBusy = false; }
  }
  function beginEdit(attendee: typeof rosterAttendees[number]) {
    editingAttendeeId = attendee.id; editName = attendee.name; editAffiliation = attendee.affiliation ?? ""; editVenueId = attendee.venue_id ?? "";
    editAnswers = { ...attendee.answers }; editRevision = attendee.revision ?? 0; editMessage = "";
  }
  function requestAttendeeCheckin(attendee: typeof rosterAttendees[number]) { confirmAttendee = attendee; }
  async function confirmAttendeeCheckin() { if (!confirmAttendee) return; const attendee = confirmAttendee; confirmAttendee = null; await checkInAttendee(attendee.id); }
  async function saveAttendeeEdit() {
    try {
      const answers = Object.fromEntries(walkInFields.map((field) => [field.field_key, editAnswers[field.field_key] ?? null]));
      const body = await api(`/events/${selectedEventId}/attendees/${editingAttendeeId}`, { method: "PATCH", body: JSON.stringify({ name: editName, affiliation: editAffiliation || null, venueId: editVenueId || null, answers, revision: editRevision }) });
      editRevision = body.revision; editingAttendeeId = ""; editMessage = "名簿を更新しました。"; await loadRoster(selectedEventId);
    } catch (error) { editMessage = error instanceof Error ? error.message : "名簿を更新できませんでした。"; }
  }
  async function previewCsv() {
    const eventId = selectedEventId;
    try {
      const mapping = { name: csvMapping.name ?? "", affiliation: csvMapping.affiliation ?? "", email: csvMapping.email ?? "", venueId: csvMapping.venueId ?? "", ...Object.fromEntries(rosterFields.map((field) => [`answer:${field.field_key}`, csvMapping[`answer:${field.field_key}`] ?? ""])) };
      const preview = await api(`/events/${eventId}/roster/import/preview`, { method: "POST", body: JSON.stringify({ columns: csvColumns, rows: csvRows, mapping }) });
      if (selectedEventId !== eventId) return;
      csvPreview = preview;
      csvDecisions = preview.rows.map((row: { duplicateCandidates: unknown[]; errors: string[] }) => row.duplicateCandidates.length || row.errors.length ? "skip" : "include"); csvMessage = `プレビュー: ${preview.validCount} 行を登録できます。`;
    } catch (error) { csvMessage = error instanceof Error ? error.message : "CSVを確認できませんでした。"; }
  }
  function readCsvFile(file: File | undefined) {
    csvPreview = null; csvMessage = ""; csvColumns = []; csvRows = []; csvMapping = {}; csvDecisions = [];
    if (!file) return;
    if (file.size > 1_000_000) { csvMessage = "CSVはUTF-8、1 MB以下、データ100行・100列以下にしてください。"; return; }
    const eventId = selectedEventId;
    void file.arrayBuffer().then((buffer) => {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (selectedEventId !== eventId) return;
      const source = text.replace(/^\uFEFF/, ""); const parsed: string[][] = []; let row: string[] = [], value = "", quoted = false;
      for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === '"' && quoted && source[i + 1] === '"') { value += '"'; i++; }
        else if (char === '"') quoted = !quoted;
        else if (char === "," && !quoted) { row.push(value); value = ""; }
        else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && source[i + 1] === "\n") i++; row.push(value); value = ""; if (row.some((cell) => cell !== "")) parsed.push(row); row = []; }
        else value += char;
      }
      if (quoted) { csvMessage = "CSVの引用符が閉じていません。"; return; }
      row.push(value); if (row.some((cell) => cell !== "")) parsed.push(row);
      if (parsed.length < 2) { csvMessage = "見出し行とデータ行を含む CSV を選んでください。"; return; }
      if (parsed.some((cells) => cells.length !== parsed[0].length)) { csvMessage = "CSVの各行で列数が一致しません。"; return; }
      if (parsed[0].length > 100) { csvMessage = "CSVは100列以下にしてください。"; return; }
      if (parsed.length - 1 > 100) { csvMessage = "CSVはデータ100行以下にしてください。"; return; }
      csvColumns = parsed[0]; csvRows = parsed.slice(1); csvMapping = { name: csvColumns.find((column) => /^(氏名|名前|name)$/i.test(column)) ?? "", affiliation: csvColumns.find((column) => /^(所属|会社|affiliation)$/i.test(column)) ?? "", email: csvColumns.find((column) => /^(メール|メールアドレス|email)$/i.test(column)) ?? "", venueId: csvColumns.find((column) => /^(会場|venue)$/i.test(column)) ?? "" };
      for (const field of rosterFields) csvMapping[`answer:${field.field_key}`] = csvColumns.find((column) => column === `answer:${field.field_key}`) ?? csvColumns.find((column) => column === field.label || column === field.field_key) ?? "";
    }).catch(() => { csvColumns = []; csvRows = []; csvMapping = {}; csvMessage = "CSVをUTF-8で読み込めませんでした。"; });
  }
  function invalidateCsvPreview() { csvPreview = null; csvDecisions = []; if (csvMessage.startsWith("プレビュー:")) csvMessage = "列の対応を変更しました。プレビューをやり直してください。"; }
  function csvErrorText(error: string) {
    if (error === "name_required_or_too_long") return "氏名を確認してください。";
    if (error.startsWith("required:")) return `必須項目「${error.slice(9)}」を入力してください。`;
    if (error.startsWith("invalid:")) return `項目「${error.slice(8)}」の値を確認してください。`;
    if (error === "duplicate_in_import") return "CSV内で重複しています。";
    return "入力内容を確認してください。";
  }
  async function commitCsv() {
    if (!csvPreview) return;
    const eventId = selectedEventId;
    try { const decisions = csvPreview.rows.map((row, rowIndex) => ({ rowIndex, action: row.errors.length ? "skip" : row.duplicateCandidates.length ? csvDecisions[rowIndex] : "include" }));
      const result = await api(`/events/${eventId}/roster/import/commit`, { method: "POST", body: JSON.stringify({ previewToken: csvPreview.previewToken, decisions }) });
      if (selectedEventId !== eventId) return;
      csvMessage = `${result.imported ?? result.created ?? 0} 件を取り込みました。`; csvPreview = null; csvRows = []; await loadRoster(eventId);
    } catch (error) { csvMessage = error instanceof Error ? error.message : "CSVを確定できませんでした。"; }
  }
  async function reverseCheckIn(ticketId: string) {
    const reason = window.prompt("受付取消の理由を入力してください。");
    if (!reason?.trim()) return;
    lastCheckinBy = ""; checkinMessage = "受付取消を処理しています…";
    try { await api(`/tickets/${ticketId}/reverse-check-in`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }); checkinMessage = "受付を取り消しました。"; await Promise.all([loadMetrics(selectedEventId), loadRoster(selectedEventId)]); }
    catch (error) { checkinMessage = error instanceof Error ? error.message : "受付を取り消せませんでした。"; }
  }
  async function loadMetrics(eventId: string) {
    try { selectedEventId = eventId; metrics = await api(`/events/${eventId}/metrics`); }
    catch (error) { message = error instanceof Error ? error.message : "集計を読み込めませんでした。"; }
  }
  async function loadRoster(eventId: string, append = false) {
    if (!append && selectedEventId === eventId) rosterReady = false;
    try {
      const params = new URLSearchParams();
      if (rosterQuery) params.set("q", rosterQuery);
      if (rosterStatus) params.set("status", rosterStatus);
      if (rosterSource) params.set("source", rosterSource);
      if (rosterVenueId) params.set("venueId", rosterVenueId);
      if (append && rosterCursor) params.set("after", rosterCursor);
      const roster = await api(`/events/${eventId}/roster?${params}`);
      if (selectedEventId !== eventId) return;
      rosterFields = roster.fields; rosterAttendees = append ? [...rosterAttendees, ...roster.attendees] : roster.attendees;
      rosterCursor = roster.nextCursor;
      rosterReady = true;
    }
    catch (error) { message = error instanceof Error ? error.message : "名簿を読み込めませんでした。"; }
  }
  async function loadVenues(eventId: string) {
    try {
      const result = await api(`/events/${eventId}/venues`);
      venues = result.venues;
      if (!venues.some((venue: { id: string }) => venue.id === selectedVenueId)) selectedVenueId = venues[0]?.id ?? "";
    } catch { venues = []; selectedVenueId = ""; }
  }
  async function addVenue() {
    try { await api(`/events/${selectedEventId}/venues`, { method: "POST", body: JSON.stringify({ name: newVenueName }) }); newVenueName = ""; await loadVenues(selectedEventId); }
    catch (error) { message = error instanceof Error ? error.message : "会場を追加できませんでした。"; }
  }
  async function assignVenueStaff() {
    try { if (!selectedVenueId || !selectedStaffId) return; await api(`/events/${selectedEventId}/venues/${selectedVenueId}/staff/${selectedStaffId}`, { method: "PUT" }); selectedStaffId = ""; message = "担当会場を設定しました。"; }
    catch (error) { message = error instanceof Error ? error.message : "担当会場を設定できませんでした。"; }
  }
  async function registerWalkIn() {
    if (!walkInFieldsReady || walkInSaving) return;
    lastCheckinBy = ""; checkinMessage = "";
    walkInSaving = true; walkInQr = "";
    try {
      const result = await api(`/events/${selectedEventId}/attendees`, { method: "POST", body: JSON.stringify({ name: walkInName, email: walkInEmail || undefined, venueId: selectedVenueId || undefined, answers: walkInAnswers }) });
      walkInName = ""; walkInEmail = ""; walkInAnswers = {};
      checkinMessage = "当日参加者を登録しました。QR を本人に渡してください。";
      try { walkInQr = await QRCode.toDataURL(`${window.location.origin}/public/tickets/${result.ticketId}/check-in/${result.qrToken}`, { errorCorrectionLevel: "M", margin: 1, width: 640 }); }
      catch { checkinMessage = "当日参加者は登録済みですが、QR を表示できませんでした。名簿から受付してください。"; }
      await Promise.all([loadMetrics(selectedEventId), loadRoster(selectedEventId)]);
    }
    catch (error) { checkinMessage = error instanceof Error ? error.message : "当日参加者を登録できませんでした。"; }
    finally { walkInSaving = false; }
  }
  async function resendTicketLink(attendeeId: string) {
    ticketLinkMessage = "";
    try { await api(`/events/${selectedEventId}/attendees/${attendeeId}/ticket-link`, { method: "POST" }); ticketLinkMessage = "チケットのメール送信を予約しました。"; }
    catch (error) { ticketLinkMessage = error instanceof Error ? error.message : "チケットを送信できませんでした。"; }
  }
  async function loadWalkInFields(eventId: string) {
    walkInFieldsReady = false; walkInFieldMessage = "申込項目を読み込んでいます。";
    try {
      const fields: FormField[] = await api(`/events/${eventId}/form-fields`);
      if (selectedEventId !== eventId) return;
      walkInFields = fields; walkInFieldsReady = true; walkInFieldMessage = "";
    } catch (error) {
      if (selectedEventId === eventId) walkInFieldMessage = error instanceof Error ? error.message : "申込項目を読み込めませんでした。";
    }
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
  async function loadApiTokens() { try { apiTokens = (await api("/tokens")).tokens; } catch { apiTokens = []; } }
  async function createApiToken() {
    try { const result = await api("/tokens", { method: "POST", body: JSON.stringify({ label: newTokenLabel, scopes: [newTokenScope] }) }); newTokenValue = result.token; newTokenLabel = ""; await loadApiTokens(); }
    catch (error) { profileMessage = error instanceof Error ? error.message : "トークンを発行できませんでした。"; }
  }
  async function createInvite() {
    try { const result = await api(`/organizations/${organizationId}/invites`, { method: "POST", body: JSON.stringify({ role: inviteRole, email: inviteEmail || undefined }) }); inviteUrl = result.url; inviteEmail = ""; }
    catch (error) { profileMessage = error instanceof Error ? error.message : "招待を作成できませんでした。"; }
  }
  async function loadInvite() {
    try { const response = await fetch(`/public/invites/${inviteToken}`); const body = await response.json(); if (!response.ok) throw new Error(body.error); inviteInfo = body; inviteMessage = "Passkey を登録して参加してください。"; }
    catch { inviteMessage = "この招待リンクは期限切れか、すでに使用されています。"; }
  }
  async function acceptInvite() {
    try {
      const optionsResponse = await fetch(`/public/invites/${inviteToken}/passkey/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: inviteDisplayName }) });
      const optionBody = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(optionBody.error);
      const credential = await startRegistration({ optionsJSON: optionBody.options });
      const response = await fetch(`/public/invites/${inviteToken}/passkey/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: optionBody.challengeId, response: credential }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      window.location.assign("/");
    } catch (error) { inviteMessage = error instanceof Error ? error.message : "招待に参加できませんでした。"; }
  }
  async function revokeApiToken(id: string) {
    try { await api(`/tokens/${id}`, { method: "DELETE" }); await loadApiTokens(); }
    catch (error) { profileMessage = error instanceof Error ? error.message : "トークンを失効できませんでした。"; }
  }
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
  async function selectEvent(eventId: string) {
    rosterReady = false; rosterFields = []; rosterAttendees = [];
    walkInName = ""; walkInEmail = ""; walkInAnswers = {}; walkInQr = ""; walkInFields = []; checkinMessage = "";
    await Promise.all([loadMetrics(eventId), loadRoster(eventId), loadSchedule(eventId), loadOrganizers(eventId), loadVenues(eventId), loadWalkInFields(eventId)]);
  }
  async function createField() {
    try {
      const options = fieldOptions.split(/[\n,]/).map((option) => option.trim()).filter(Boolean);
      await api(`/events/${selectedEventId}/form-fields`, { method: "POST", body: JSON.stringify({ key: fieldKey, label: fieldLabel, type: fieldType, required: fieldRequired, options }) });
      fieldKey = ""; fieldLabel = ""; fieldOptions = ""; fieldRequired = false; fieldMessage = "項目を追加しました。";
      await Promise.all([loadRoster(selectedEventId), loadWalkInFields(selectedEventId)]);
    } catch (error) { fieldMessage = error instanceof Error ? error.message : "項目を追加できませんでした。"; }
  }
  async function loadRegistration() {
    try { const response = await fetch(`/public/events/${registrationEventId}`); const body = await response.json(); if (!response.ok) throw new Error(); publicEvent = body.event; publicFields = body.fields; turnstileSiteKey = body.turnstileSiteKey ?? ""; if (turnstileSiteKey) await renderTurnstile(); }
    catch { registrationMessage = "この申込フォームは利用できません。"; }
  }
  async function renderTurnstile() {
    await tick();
    const holder = document.getElementById("registration-turnstile");
    if (!holder) return;
    const turnstileWindow = window as Window & { turnstile?: { render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void }) => void } };
    if (!turnstileWindow.turnstile) {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      document.head.appendChild(script);
      await new Promise<void>((resolve, reject) => { script.onload = () => resolve(); script.onerror = () => reject(new Error("Turnstile を読み込めませんでした")); });
    }
    turnstileWindow.turnstile?.render(holder, { sitekey: turnstileSiteKey, callback: (token) => turnstileToken = token, "expired-callback": () => turnstileToken = "" });
  }
  async function loadPublicSchedule() {
    try { const response = await fetch(`/public/events/${scheduleEventId}/schedule`); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); publicSchedule = body; if (body.options[0]?.date) { const [year, month] = body.options[0].date.split("-").map(Number); calendarMonth = new Date(year, month - 1, 1); } }
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
    try { const response = await fetch(`/public/events/${registrationEventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: registrationName, email: registrationEmail || undefined, answers: registrationAnswers, turnstileToken }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); issuedTicket = { id: body.ticketId, token: body.ticketToken }; ticketQr = await QRCode.toDataURL(`${window.location.origin}/public/tickets/${body.ticketId}/check-in/${body.qrToken}`, { errorCorrectionLevel: "M", margin: 1, width: 640 }); registrationMessage = body.emailQueued ? "申込を受け付け、QRチケットのメール送信を予約しました。" : "申込を受け付けました。チケットはこの画面から離れる前に保存してください。"; }
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
  function answerText(value: unknown) { return Array.isArray(value) ? value.join(", ") : value === true ? "Yes" : value === false ? "No" : typeof value === "string" || typeof value === "number" ? String(value) : ""; }
  function publicScheduleOption(date: string) { return publicSchedule?.options.find((option) => option.date === date); }
</script>

<svelte:head><meta name="description" content="軽量なイベント名簿・受付管理" /></svelte:head>
<main>
{#if inviteToken}
  <header><h1>tsudoi への招待</h1></header><section><h2>{inviteInfo?.organizationName ?? "組織"}</h2><p class="notice" aria-live="polite">{inviteMessage}</p>{#if inviteInfo}<p>役割: {inviteInfo.role}</p>{#if inviteInfo.email}<p>メール: {inviteInfo.email}</p>{/if}<form onsubmit={(event) => { event.preventDefault(); void acceptInvite(); }}><label>表示名<input bind:value={inviteDisplayName} required /></label><button>Passkey を登録して参加</button></form>{/if}</section>
{:else if ticketPage}
  <header><p class="eyebrow">YOUR TICKET</p><h1>tsudoi</h1><p>参加者チケット</p></header>
  {#if participantTicket}
    <section aria-labelledby="ticket-title"><h2 id="ticket-title">{participantTicket.event_name}</h2>
      <p><strong>状態: {participantTicket.status}</strong></p>
      <p>{participantTicket.starts_at} – {participantTicket.ends_at} ({participantTicket.timezone})</p>
      {#if participantTicket.venue_name}<p>会場: {participantTicket.venue_name}</p>{/if}
      {#if participantTicket.status === "issued"}<button onclick={cancelParticipantTicket}>参加をキャンセルする</button>{/if}
    </section>
    {#if participantTicket.status === "issued"}<section aria-labelledby="participant-qr"><h2 id="participant-qr">受付 QR</h2><p>表示後 15 分間有効です。会場で期限が切れたら更新してください。</p>{#if participantQr}<img src={participantQr} alt="受付用 QR コード" width="320" height="320" />{/if}<button onclick={refreshParticipantQr}>QR を更新</button></section>{/if}
  {:else}<section><p class="notice" aria-live="polite">{participantMessage}</p><button onclick={signInParticipant}>Passkey でログイン</button></section>{/if}
{:else if scheduleEventId}
  <header><p class="eyebrow">SCHEDULE POLL</p><h1>tsudoi</h1><p>{publicSchedule?.event.name ?? "日程調整"}</p></header>
  {#if publicSchedule}
    <section><h2>{publicSchedule.event.name} の日程調整</h2><p>{publicSchedule.event.description}</p>
      {#if publicSchedule.event.schedule_status === "confirmed"}<p class="notice">日程は確定しています。</p>{:else}
        <label>お名前<input bind:value={scheduleRespondentName} required placeholder="山田太郎" /></label>
        <p class="muted">参加できる候補日をクリックしてください。もう一度クリックすると回答を外せます。</p>
        <div class="calendar-head"><button type="button" class="quiet" aria-label="前月" onclick={() => moveCalendarMonth(-1)}>‹</button><strong>{monthLabel(calendarMonth)}</strong><button type="button" class="quiet" aria-label="翌月" onclick={() => moveCalendarMonth(1)}>›</button></div>
        <div class="calendar-grid public-calendar">{#each ["日", "月", "火", "水", "木", "金", "土"] as weekday}<span class="calendar-weekday">{weekday}</span>{/each}{#each calendarDays(calendarMonth) as date}<div class="calendar-cell">{#if date}{@const option = publicScheduleOption(date)}{#if option}<button type="button" class:chosen={scheduleResponses[option.id] === "yes"} disabled={!scheduleRespondentName.trim()} onclick={() => void submitScheduleResponse(option.id, scheduleResponses[option.id] === "yes" ? "no" : "yes")}>{Number(date.slice(-2))}<small>{scheduleResponses[option.id] === "yes" ? "参加" : "候補日"}</small></button>{/if}{/if}</div>{/each}</div>
        <div class="schedule-list">{#each publicSchedule.options as option}<div class="schedule-option"><div><strong>{scheduleOptionLabel(option)}</strong>{#if option.note}<p class="muted">{option.note}</p>{/if}<p class="muted">○ {option.yes ?? 0}　△ {option.maybe ?? 0}　× {option.no ?? 0}</p></div><div class="response-buttons"><button class:chosen={scheduleResponses[option.id] === "maybe"} disabled={!scheduleRespondentName.trim()} onclick={() => void submitScheduleResponse(option.id, "maybe")}>△ 未定</button><button class:chosen={scheduleResponses[option.id] === "no"} disabled={!scheduleRespondentName.trim()} onclick={() => void submitScheduleResponse(option.id, "no")}>× 不参加</button></div></div>{/each}</div>
        <section class="schedule-form"><h3>AI に日程調整を任せる</h3><p class="muted">Grok には下の MCP URL をカスタムコネクタとして一度追加します。招待リンクのトークンで、この調整に参加できます。イベントごとのトークンは、OAuth を使わないクライアント向けです。</p><label>MCP URL<input readonly value={mcpUrl} /></label><button disabled={!scheduleRespondentName.trim()} onclick={() => void createAgentConnection()}>AI連携用トークンを発行</button><button class="quiet" disabled={!scheduleRespondentName.trim()} onclick={() => void loadAgentConnections()}>接続を確認</button>{#if agentConnection}<p class="notice">このトークンは一度だけ表示されます。AIのMCP接続設定に登録してください。</p><label>MCP URL<input readonly value={agentConnection.mcpUrl} /></label><label>アクセストークン<input readonly value={agentConnection.token} /></label><p class="muted">有効期限: {agentConnection.expiresInDays} 日。日程確定後は可否の変更が自動で停止します。</p>{/if}{#if agentConnections.length > 0}<h4>AI連携</h4><ul>{#each agentConnections as connection}<li><span>{connection.revoked_at ? "解除済み" : `有効（${connection.expires_at}まで）`}</span>{#if !connection.revoked_at}<button class="quiet" onclick={() => void revokeAgentConnection(connection.id)}>解除</button>{/if}</li>{/each}</ul>{/if}</section>
      {/if}
    </section>
  {:else}<p class="notice" aria-live="polite">{scheduleResponseMessage}</p>{/if}
  {#if scheduleResponseMessage}<p class="notice" aria-live="polite">{scheduleResponseMessage}</p>{/if}
{:else if registrationEventId}
  <header><p class="eyebrow">EVENT REGISTRATION</p><h1>tsudoi</h1><p>{publicEvent?.name ?? "申込フォーム"}</p></header>
  {#if publicEvent}<section><h2>{publicEvent.name}</h2><p>{publicEvent.description}</p><p>{publicEvent.starts_at}</p><form onsubmit={(event) => { event.preventDefault(); void register(); }}><label>氏名<input bind:value={registrationName} required /></label><label>メールアドレス<input bind:value={registrationEmail} type="email" /></label><FieldInputs fields={publicFields} bind:answers={registrationAnswers} />{#if turnstileSiteKey}<div id="registration-turnstile"></div>{/if}<button disabled={Boolean(turnstileSiteKey) && !turnstileToken}>申し込む</button></form></section>{/if}
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
      {#if screen !== "home"}<button class="quiet" onclick={goHome}>イベント</button>{/if}
      {#if isAdministrator}<button class="quiet" onclick={() => screen = "admin"}>管理メニュー</button>{/if}
    </nav></header>
    {#if screen === "home"}
      <p class="notice" aria-live="polite">{message}</p>
      {#if isAdministrator}<section class="focus-card" aria-labelledby="new-event"><h2 id="new-event">新しいイベントを作成</h2>
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
      {:else}<label>開催日<input bind:value={eventDate} type="date" required /></label>{/if}
      <button>作成する</button>
    </form>
      </section>{/if}
      <section aria-labelledby="events"><h2 id="events">あなたのイベント</h2>
        {#if events.length === 0}<p>まだイベントがありません。</p>{:else}<ul>{#each events as event}<li><div><strong>{event.name}</strong><p class="muted">{event.scheduling_enabled === 1 && event.schedule_status !== "confirmed" ? "日程調整中" : `${event.starts_at} · ${event.status}`}</p></div><button onclick={() => openEvent(event.id)}>管理する</button></li>{/each}</ul>{/if}
      </section>
    {:else if screen === "admin"}
      <section aria-labelledby="admin-menu"><h2 id="admin-menu">プロフィール</h2><p>表示名はイベントの運営メンバー表示に使われます。メールアドレスは非公開です。</p>
        <div class="avatar-setup"><img src={profileAvatarUrl || identiconUrl(profileName)} alt="プロフィール画像のプレビュー" /><div><label>プロフィール画像（任意）<input accept="image/png,image/jpeg,image/webp" onchange={(event) => void selectProfileAvatar(event.currentTarget.files?.[0])} type="file" /></label>{#if profileAvatarUrl}<button type="button" class="quiet" onclick={() => profileAvatarUrl = ""}>画像を外す</button>{/if}</div></div>
        <label>お名前<input bind:value={profileName} required /></label><label>メールアドレス（任意・非公開）<input bind:value={profileEmail} type="email" /></label><button onclick={saveProfile}>保存する</button>{#if profileMessage}<p class="notice">{profileMessage}</p>{/if}
      </section>
      <section aria-labelledby="api-tokens"><h2 id="api-tokens">外部連携 API トークン</h2><p>発行時に表示される値を安全な場所へ保存してください。以後は再表示できません。</p><form onsubmit={(event) => { event.preventDefault(); void createApiToken(); }}><label>ラベル<input bind:value={newTokenLabel} required /></label><label>権限<select bind:value={newTokenScope}><option value="roster:read">名簿閲覧</option><option value="roster:write">名簿登録</option><option value="checkin:write">受付</option><option value="messages:write">メッセージ送信</option><option value="admin">管理</option></select></label><button>発行</button></form>{#if newTokenValue}<label>新しいトークン<input readonly value={newTokenValue} /></label><button class="quiet" onclick={() => newTokenValue = ""}>表示を閉じる</button>{/if}<ul>{#each apiTokens as token}<li><strong>{token.label}</strong> {token.scopes.join(", ")} {token.revoked_at ? "失効済み" : "有効"}{#if !token.revoked_at}<button class="quiet" onclick={() => revokeApiToken(token.id)}>失効</button>{/if}</li>{/each}</ul></section>
      <section aria-labelledby="organization-invite"><h2 id="organization-invite">運営メンバーを招待</h2><form onsubmit={(event) => { event.preventDefault(); void createInvite(); }}><label>役割<select bind:value={inviteRole}><option value="staff">スタッフ</option><option value="admin">管理者</option><option value="viewer">閲覧者</option></select></label><label>メールアドレス（任意）<input bind:value={inviteEmail} type="email" /></label><button>招待リンクを作成</button></form>{#if inviteUrl}<label>招待リンク（7日間有効）<input readonly value={inviteUrl} /></label>{/if}</section>
      <section aria-labelledby="admin-session"><h2 id="admin-session">ログイン</h2><p>この端末のログイン状態を管理します。</p>
        <button onclick={signOut}>ログアウト</button>
      </section>
    {:else}
      <section class="event-title"><h2>{events.find((event) => event.id === selectedEventId)?.name ?? "イベント管理"}</h2><p>必要な作業を選んでください。</p></section>
      {#if schedule?.enabled && schedule.status !== "confirmed"}
        <section aria-labelledby="schedule-management"><h2 id="schedule-management">日程を調整</h2><p>候補日を選んで、参加者に回答してもらいます。</p>
          <p class="muted">共有用URL: <a href={`/events/${selectedEventId}/schedule`} target="_blank" rel="noreferrer">日程調整ページを開く</a></p>
          {#if isAdministrator}<div class="schedule-form"><p class="muted">Grok のコネクタ URL は参加者にも共通です。招待リンクを渡すと、相手の Grok がこの調整へ参加できます。</p><label>MCP URL<input readonly value={mcpUrl} /></label><button type="button" onclick={() => void createScheduleInvite("required")}>必須参加者の招待リンク</button><button type="button" class="quiet" onclick={() => void createScheduleInvite("optional")}>任意参加者の招待リンク</button>{#if scheduleInviteUrl}<label>招待リンク（14日間）<input readonly value={scheduleInviteUrl} /></label>{/if}</div>{/if}
          {#if schedule.participants && schedule.participants.length > 0}{@const waiting = schedule.participants.filter((participant) => !participant.answered)}<p class="muted">{waiting.length > 0 ? `未回答: ${waiting.map((participant) => participant.displayName).join("、")}` : "招待した参加者は回答済みです。"}</p>{/if}
          {#if isAdministrator}<form onsubmit={(event) => { event.preventDefault(); void addScheduleOption(); }} class="schedule-form"><div class="calendar-head"><button type="button" class="quiet" aria-label="前月" onclick={() => moveCalendarMonth(-1)}>‹</button><strong>{monthLabel(calendarMonth)}</strong><button type="button" class="quiet" aria-label="翌月" onclick={() => moveCalendarMonth(1)}>›</button></div><div class="calendar-grid">{#each ["日", "月", "火", "水", "木", "金", "土"] as weekday}<span class="calendar-weekday">{weekday}</span>{/each}{#each calendarDays(calendarMonth) as date}<div class="calendar-cell">{#if date}<button type="button" class:chosen={scheduleDraftDates.includes(date)} onclick={() => toggleScheduleDraftDate(date)}>{Number(date.slice(-2))}</button>{/if}</div>{/each}</div><label>メモ（任意・選んだ日すべてに付与）<input bind:value={scheduleNote} placeholder="会場の都合など" /></label><button disabled={scheduleDraftDates.length === 0}>選んだ {scheduleDraftDates.length} 日を候補に追加</button></form>{/if}
          {#if schedule.options.length === 0}<p>候補日を追加してください。</p>{:else}<div class="schedule-list">{#each schedule.options as option}<div class="schedule-option"><div><strong>{scheduleOptionLabel(option)}</strong>{#if option.note}<p class="muted">{option.note}</p>{/if}<p class="muted">○ {option.yes ?? 0}　△ {option.maybe ?? 0}　× {option.no ?? 0}</p>{#if schedule.readyToConfirm?.includes(option.id)}<p class="muted">必須参加者が全員参加できる枠です。</p>{/if}</div>{#if isAdministrator}<button onclick={() => void confirmSchedule(option.id)}>この日に確定</button>{/if}</div>{/each}</div>{/if}
        </section>
      {:else if schedule?.enabled}
        <section class="notice"><strong>日程確定済み</strong><p>{schedule.startsAt ? scheduleOptionLabel({ date: schedule.date ?? "", start: schedule.startsAt, end: schedule.endsAt, allDay: schedule.allDay }) : ""}</p><p class="muted">{schedule.allDay === false ? "この時刻を参加者へ案内できます。" : "時刻は参加者へ別途ご連絡ください。"}</p></section>
      {/if}
      {#if schedule?.enabled && schedule.status === "confirmed" && isAdministrator}<section aria-labelledby="announcement"><h2 id="announcement">参加者へ案内</h2><p>確定した日程や、時刻・場所の連絡をメールでまとめて送れます。</p><form onsubmit={(event) => { event.preventDefault(); void sendAnnouncement(); }}><label>件名<input bind:value={announcementSubject} placeholder="集合時刻と場所のご案内" required /></label><label>本文<textarea bind:value={announcementBody} placeholder="確定日、集合時刻、場所、持ち物など" required></textarea></label><button>参加者へ送信</button></form>{#if announcementMessage}<p class="notice">{announcementMessage}</p>{/if}</section>{/if}
      <div class="management-grid"><a href="#roster">名簿を管理</a>{#if currentRole !== "viewer"}<a href="#check-in">QR 受付</a>{/if}{#if isAdministrator}<a href="#settings">申込フォーム設定</a>{/if}</div>
      {#if isAdministrator}
        {@const currentEvent = events.find((event) => event.id === selectedEventId)}
        {#if currentEvent?.status === "draft"}<button class="quiet action" onclick={() => publishEvent(selectedEventId)}>イベントを公開する</button>{:else if currentEvent?.status === "published"}<button class="quiet action" onclick={() => closeEvent(selectedEventId)}>イベントを終了する</button>{/if}
        {#if currentEvent}<button class="quiet action" onclick={() => removeEvent(selectedEventId, currentEvent.status === "draft" && (metrics?.registrations ?? 0) === 0)}>{currentEvent.status === "draft" && (metrics?.registrations ?? 0) === 0 ? "下書きを削除する" : "イベントをアーカイブする"}</button>{/if}
      {/if}
      {#if isAdministrator}<section aria-labelledby="organizers"><h2 id="organizers">運営メンバー</h2><p>主催者と共同主催者を確認・追加できます。</p><ul>{#each organizers as organizer}<li><div><strong>{organizer.display_name || "名称未設定"}</strong><span>{organizer.role === "organizer" ? "主催者" : "共同主催者"}</span></div><button class="quiet" onclick={() => void removeOrganizer(organizer.user_id)}>外す</button></li>{/each}</ul><form onsubmit={(event) => { event.preventDefault(); void addCohost(); }}><label>共同主催者<select bind:value={selectedCohostId}><option value="">選択してください</option>{#each organizationMembers.filter((member) => !organizers.some((organizer) => organizer.user_id === member.id)) as member}<option value={member.id}>{member.display_name || member.email_normalized || member.id}</option>{/each}</select></label><button disabled={!selectedCohostId}>追加する</button></form></section>{/if}
      {#if isAdministrator}<section aria-labelledby="venues"><h2 id="venues">会場とスタッフ</h2><form onsubmit={(event) => { event.preventDefault(); void addVenue(); }}><label>会場名<input bind:value={newVenueName} required /></label><button>会場を追加</button></form>{#if venues.length > 0}<form onsubmit={(event) => { event.preventDefault(); void assignVenueStaff(); }}><label>スタッフ<select bind:value={selectedStaffId}><option value="">選択してください</option>{#each organizationMembers.filter((member) => member.role === "staff") as member}<option value={member.id}>{member.display_name || member.id}</option>{/each}</select></label><button disabled={!selectedStaffId || !selectedVenueId}>選択中の会場を担当にする</button></form>{/if}</section>{/if}
      {#if isAdministrator}{@const checklistEvent = events.find((event) => event.id === selectedEventId)}<section aria-labelledby="publish-check"><h2 id="publish-check">公開前チェック</h2><ul class="checklist"><li class:complete={Boolean(checklistEvent?.name)}>イベント名</li><li class:complete={!checklistEvent?.scheduling_enabled || schedule?.status === "confirmed"}>日程{checklistEvent?.scheduling_enabled ? "を確定" : "を設定"}</li><li class:complete={rosterFields.length > 0}>申込項目（任意）</li><li class:complete={checklistEvent?.status === "published"}>公開</li></ul></section>{/if}
      {#if metrics}
        <section aria-labelledby="metrics"><h2 id="metrics">受付状況</h2>
      <dl class="metrics"><div><dt>申込</dt><dd>{metrics.registrations ?? 0}</dd></div><div><dt>発券</dt><dd>{metrics.issued ?? 0}</dd></div><div><dt>取消</dt><dd>{metrics.cancelled ?? 0}</dd></div><div><dt>受付済</dt><dd>{metrics.checked_in ?? 0}</dd></div><div><dt>未受付</dt><dd>{metrics.not_checked_in ?? 0}</dd></div></dl>
        </section>
      {/if}
      <section aria-labelledby="roster"><h2 id="roster">名簿を管理</h2><p class="muted">申込者と受付状態を確認できます。</p><form onsubmit={(event) => { event.preventDefault(); void loadRoster(selectedEventId); }}><label>検索<input bind:value={rosterQuery} placeholder="氏名またはメール" /></label><label>状態<select bind:value={rosterStatus}><option value="">すべて</option><option value="active">有効</option><option value="cancelled">取消</option></select></label><label>申込経路<select bind:value={rosterSource}><option value="">すべて</option><option value="public_form">事前申込</option><option value="walk_in">当日登録</option></select></label><label>会場<select bind:value={rosterVenueId}><option value="">すべて</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label><button>絞り込む</button></form>
      {#if ticketLinkMessage}<p class="notice" aria-live="polite">{ticketLinkMessage}</p>{/if}
      {#if isAdministrator}<section aria-labelledby="roster-import"><h3 id="roster-import">CSVから名簿を取り込む</h3><p class="muted">UTF-8 CSV、1 MB以下、データ100行・100列以下にしてください。CSV取込ではメールを送信しません。メールのない参加者は名簿から本人確認して受付してください。会場列は同じイベント内の会場名またはID、複数選択は「|」区切り、チェック項目は true / false、数値は有限の数で指定します。</p><label>CSVファイル<input type="file" accept=".csv,text/csv" disabled={!rosterReady} onchange={(event) => readCsvFile(event.currentTarget.files?.[0])} /></label>
        {#if csvColumns.length}<div class="form-grid"><label>氏名列<select bind:value={csvMapping.name} onchange={invalidateCsvPreview}><option value="">列を選択</option>{#each csvColumns as column}<option value={column}>{column}</option>{/each}</select></label><label>所属列<select bind:value={csvMapping.affiliation} onchange={invalidateCsvPreview}><option value="">列を選択</option>{#each csvColumns as column}<option value={column}>{column}</option>{/each}</select></label><label>メール列<select bind:value={csvMapping.email} onchange={invalidateCsvPreview}><option value="">列を選択</option>{#each csvColumns as column}<option value={column}>{column}</option>{/each}</select></label><label>会場列<select bind:value={csvMapping.venueId} onchange={invalidateCsvPreview}><option value="">列を選択</option>{#each csvColumns as column}<option value={column}>{column}</option>{/each}</select></label>
        {#each rosterFields as field}<label>{field.label}列<select bind:value={csvMapping[`answer:${field.field_key}`]} onchange={invalidateCsvPreview}><option value="">列を選択</option>{#each csvColumns as column}<option value={column}>{column}</option>{/each}</select></label>{/each}</div><button type="button" onclick={() => void previewCsv()}>プレビューを確認</button>{/if}
        {#if csvPreview}<p>{csvPreview.validCount} 行を取り込み可能</p><div class="table-scroll"><table><thead><tr><th>氏名</th><th>所属</th><th>メール</th><th>重複候補・判断</th></tr></thead><tbody>{#each csvPreview.rows as row, rowIndex}<tr><td>{row.values[csvColumns.indexOf(csvMapping.name)] ?? ""}</td><td>{row.values[csvColumns.indexOf(csvMapping.affiliation)] ?? ""}</td><td>{row.values[csvColumns.indexOf(csvMapping.email)] ?? ""}</td><td>{#if row.errors.length}<span>{row.errors.map(csvErrorText).join("、")}</span>{:else if row.duplicateCandidates.length}{#each row.duplicateCandidates as candidate}<p>既存候補: {candidate.name}{#if candidate.affiliation}・{candidate.affiliation}{/if}{#if candidate.venueName}・会場 {candidate.venueName}{/if}{#if candidate.email} ({candidate.email}){/if}</p>{/each}<select aria-label={`重複候補の扱い ${rowIndex + 1}行目`} bind:value={csvDecisions[rowIndex]}><option value="skip">取り込まない</option><option value="include">新規として登録</option></select>{:else}重複候補なし{/if}</td></tr>{/each}</tbody></table></div><button type="button" onclick={() => void commitCsv()}>取り込みを確定</button>{/if}
        {#if csvMessage}<p class="notice" aria-live="polite">{csvMessage}</p>{/if}</section>{/if}
      {#if rosterAttendees.length === 0}<p>登録者はいません。</p>{:else}<div class="table-scroll"><table><thead><tr><th>氏名</th><th>所属</th><th>メール</th><th>会場</th><th>チケット</th><th>受付操作</th>{#each rosterFields as field}<th>{field.label}</th>{/each}</tr></thead><tbody>{#each rosterAttendees as attendee}<tr><td>{attendee.name}</td><td>{attendee.affiliation ?? ""}</td><td>{attendee.email_normalized ?? ""}</td><td>{venues.find((venue) => venue.id === attendee.venue_id)?.name ?? ""}</td><td>{attendee.ticket_status}</td><td>{#if attendee.ticket_status === "issued" && currentRole !== "viewer"}<button class="quiet" onclick={() => requestAttendeeCheckin(attendee)}>受付</button>{:else if attendee.ticket_status === "checked_in" && isAdministrator}<button class="quiet" onclick={() => reverseCheckIn(attendee.ticket_id)}>受付取消</button>{/if}{#if isAdministrator && attendee.ticket_status === "issued" && attendee.email_normalized}<button class="quiet" onclick={() => void resendTicketLink(attendee.id)}>チケットを送信</button>{/if}{#if isAdministrator}<button class="quiet" disabled={!walkInFieldsReady} onclick={() => beginEdit(attendee)}>編集</button>{/if}</td>{#each rosterFields as field}<td>{answerText(attendee.answers[field.field_key])}</td>{/each}</tr>
        {#if editingAttendeeId === attendee.id}<tr><td colspan={6 + rosterFields.length}><form class="form-grid" onsubmit={(event) => { event.preventDefault(); void saveAttendeeEdit(); }}><label>氏名<input bind:value={editName} required /></label><label>所属<input bind:value={editAffiliation} /></label><label>会場<select bind:value={editVenueId} disabled={attendee.ticket_status === "checked_in"}><option value="">未割当</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{#if walkInFieldsReady}<FieldInputs fields={walkInFields} bind:answers={editAnswers} />{:else}<p class="notice">回答項目を読み込んでいます。</p>{/if}<button disabled={!walkInFieldsReady}>変更を保存</button><button type="button" class="quiet" onclick={() => editingAttendeeId = ""}>閉じる</button></form></td></tr>{/if}{/each}</tbody></table></div>{/if}
      {#if editMessage}<p class="notice" aria-live="polite">{editMessage}</p>{/if}
      {#if confirmAttendee}<div class="dialog-backdrop"><dialog open class="confirm-dialog" aria-modal="true" aria-labelledby="confirm-attendee-title"><h2 id="confirm-attendee-title">参加者を確認</h2><p>受付する方のお名前と所属を確認してください。</p><dl><div><dt>氏名</dt><dd>{confirmAttendee.name}</dd></div><div><dt>所属</dt><dd>{confirmAttendee.affiliation ?? "未登録"}</dd></div><div><dt>会場</dt><dd>{venues.find((venue) => venue.id === confirmAttendee?.venue_id)?.name ?? "未割当"}</dd></div>{#each rosterFields as field}<div><dt>{field.label}</dt><dd>{answerText(confirmAttendee.answers[field.field_key])}</dd></div>{/each}</dl><button disabled={checkinBusy} onclick={() => void confirmAttendeeCheckin()}>本人確認して受付</button><button class="quiet" onclick={() => confirmAttendee = null}>戻る</button></dialog></div>{/if}
      {#if rosterCursor}<button class="quiet" onclick={() => loadRoster(selectedEventId, true)}>さらに表示</button>{/if}
      </section>
      {#if isAdministrator}<section id="settings" aria-labelledby="custom-fields"><h2 id="custom-fields">申込フォーム設定</h2>
      <form onsubmit={(event) => { event.preventDefault(); void createField(); }}>
        <label>項目キー<input bind:value={fieldKey} pattern={fieldKeyPattern} placeholder="company_name" required /></label>
        <label>表示名<input bind:value={fieldLabel} placeholder="所属" required /></label>
        <label>型<select bind:value={fieldType}><option value="text">短文</option><option value="textarea">長文</option><option value="number">数値</option><option value="date">日付</option><option value="single_select">単一選択</option><option value="multi_select">複数選択</option><option value="checkbox">チェックボックス</option><option value="consent">同意</option></select></label>
        {#if fieldType === "single_select" || fieldType === "multi_select"}<label>選択肢（改行またはカンマ区切り）<textarea bind:value={fieldOptions} required></textarea></label>{/if}
        <label class="inline"><input bind:checked={fieldRequired} type="checkbox" />必須項目</label><button>項目を追加</button>
      </form>
      {#if fieldMessage}<p class="notice" aria-live="polite">{fieldMessage}</p>{/if}
      </section>{/if}
      {#if currentRole !== "viewer"}<section aria-labelledby="check-in"><h2 id="check-in">QR 受付</h2>
    {#if venues.length > 0}<label>受付会場<select bind:value={selectedVenueId}>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>{/if}
    <button class="quiet" onclick={scannerActive ? stopScanner : startScanner}>{scannerActive ? "カメラを閉じる" : "カメラで QR を読む"}</button>{#if scannerActive}<video bind:this={scannerVideo} playsinline aria-label="QR 読み取り用カメラ"></video>{/if}
    <p>チケット QR から読み取ったリンクを貼り付けてください。</p>
    <form onsubmit={(event) => { event.preventDefault(); void checkInTicketLink(); }}>
      <label>チケットリンク<input bind:value={ticketLink} type="url" inputmode="url" required /></label>
      <button disabled={checkinBusy}>受付する</button>
    </form>
    {#if checkinMessage}<p class="checkin-result" class:checkin-success={checkinMessage === "受付が完了しました。"} class:checkin-duplicate={checkinMessage.startsWith("受付済みです。")} role="status" aria-live="assertive">{checkinMessage}{#if lastCheckinBy}<span>担当: {lastCheckinBy}</span>{/if}</p>{/if}
    <h3>当日参加者を登録</h3>
    {#if walkInFieldMessage}<p class="notice" aria-live="polite">{walkInFieldMessage}</p>{#if !walkInFieldsReady}<button class="quiet" onclick={() => loadWalkInFields(selectedEventId)}>申込項目を再読み込み</button>{/if}{/if}
    <form onsubmit={(event) => { event.preventDefault(); void registerWalkIn(); }}><fieldset disabled={!walkInFieldsReady || walkInSaving}><label>氏名<input bind:value={walkInName} required /></label><label>メールアドレス（任意）<input bind:value={walkInEmail} type="email" /></label><FieldInputs fields={walkInFields} bind:answers={walkInAnswers} /><button>{walkInSaving ? "登録しています…" : "登録する"}</button></fieldset></form>
    {#if walkInQr}<img src={walkInQr} alt="当日参加者の受付用 QR コード" width="320" height="320" />{/if}
      </section>{/if}
  {/if}
{/if}
{/if}
</main>
