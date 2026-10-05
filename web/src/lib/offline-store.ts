export type OfflineCredential = { credentialHash: string; expiresAt: string; kind: "qr" | "legacy_v1" };
export type OfflineUsage = { distributionId: string; used: number; remaining: number };
export type OfflineAttendee = {
  id: string; name: string; registrationVenueId: string | null;
  presence: { state: "in" | "out"; venueId: string | null; revision: number; updatedAt: string | null };
  ticket: { id: string; status: string };
  credentials: OfflineCredential[];
  distributionUsage: OfflineUsage[];
};
export type OfflineDistribution = { id: string; name: string; unit: string; maxPerAttendee: number };
export type OfflineSnapshot = {
  organizationId: string; eventId: string; eventName: string; actorId: string; role: string;
  venueId: string; venueName: string; preparedAt: string; expiresAt: string;
  distributions: OfflineDistribution[]; attendees: OfflineAttendee[];
};
export type OfflineOperation = {
  requestId: string; eventId: string; distributionId?: string; attendeeId: string;
  type: "distribution" | "presence"; payload: Record<string, unknown>;
  createdAt: string; sequence: number; status: "pending" | "retry_only" | "needs_review"; reason?: string;
};
export type OfflineReceipt = {
  requestId: string; attendeeId: string; type: OfflineOperation["type"];
  outcome: string; completedAt: string; summary: string;
};
export type OfflineState = { snapshot: OfflineSnapshot | null; operations: OfflineOperation[]; receipts: OfflineReceipt[]; generation: number; quarantinedIdentity: { actorId: string; organizationId: string; eventId: string; venueId: string; reason?: "identity_changed" | "snapshot_expired" } | null };

const DB_NAME = "tsudoi-prepared-operations";
const DB_VERSION = 1;
const MAX_OPERATIONS = 500;
const MAX_RECEIPTS = 500;
const SNAPSHOT_KEY = "prepared";
const CONTROL_KEY = "control";
function utcMillis(value: string) { return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value); }

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("このブラウザーではオフライン保存を利用できません。"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "key" });
      if (!db.objectStoreNames.contains("operations")) {
        const store = db.createObjectStore("operations", { keyPath: "requestId" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("receipts")) {
        const store = db.createObjectStore("receipts", { keyPath: "requestId" });
        store.createIndex("completedAt", "completedAt");
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("オフライン保存領域を開けません。"));
    request.onblocked = () => reject(new Error("別のタブがオフライン保存領域を使用中です。タブを閉じて再試行してください。"));
  });
}

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("オフライン保存に失敗しました。"));
  });
}
function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("オフライン保存を読み込めません。"));
  });
}
function validGeneration(record: { generation?: number } | undefined) { return record?.generation ?? 0; }

export async function readOfflineState(): Promise<OfflineState> {
  const db = await openDb();
  try {
    const tx = db.transaction(["snapshots", "operations", "receipts", "meta"], "readonly");
    const [snapshotRow, operations, receipts, control] = await Promise.all([
      requestValue(tx.objectStore("snapshots").get(SNAPSHOT_KEY)),
      requestValue(tx.objectStore("operations").getAll()),
      requestValue(tx.objectStore("receipts").getAll()),
      requestValue(tx.objectStore("meta").get(CONTROL_KEY)),
    ]);
    await done(tx);
    return { snapshot: snapshotRow?.value ?? null, operations, receipts: receipts.sort((a, b) => b.completedAt.localeCompare(a.completedAt)), generation: validGeneration(control), quarantinedIdentity: control?.quarantinedIdentity ?? null };
  } finally { db.close(); }
}

export async function savePreparedSnapshot(snapshot: OfflineSnapshot, expectedGeneration: number) {
  const db = await openDb();
  try {
    const tx = db.transaction(["snapshots", "operations", "receipts", "meta"], "readwrite");
    const snapshots = tx.objectStore("snapshots"), operations = tx.objectStore("operations"), receipts = tx.objectStore("receipts"), meta = tx.objectStore("meta");
    const [control, pendingCount, existingSnapshot] = await Promise.all([requestValue(meta.get(CONTROL_KEY)), requestValue(operations.count()), requestValue(snapshots.get(SNAPSHOT_KEY))]);
    if (validGeneration(control) !== expectedGeneration) { tx.abort(); throw new Error("別のタブまたはログイン状態の変更で準備データが更新されました。画面を再読み込みして確認してください。"); }
    if (pendingCount > 0) { tx.abort(); throw new Error("未同期の操作があります。先に同期するか、書き出して確認後に消去してください。"); }
    if (existingSnapshot) { tx.abort(); throw new Error("別のタブで受付データが準備されました。画面を再読み込みして確認してください。"); }
    const nextGeneration = expectedGeneration + 1;
    snapshots.put({ key: SNAPSHOT_KEY, value: snapshot });
    receipts.clear();
    meta.put({ key: CONTROL_KEY, generation: nextGeneration, disabled: false, quarantinedIdentity: null });
    await done(tx);
  } finally { db.close(); }
  try { const channel = new BroadcastChannel("tsudoi-offline"); channel.postMessage({ type: "prepared" }); channel.close(); } catch { /* optional */ }
}

export async function expirePreparedSnapshot(expectedGeneration: number) {
  const db = await openDb();
  let expired = false;
  let nextGeneration = expectedGeneration;
  try {
    const tx = db.transaction(["snapshots", "operations", "receipts", "meta"], "readwrite");
    const snapshots = tx.objectStore("snapshots"), meta = tx.objectStore("meta");
    const [snapshotRow, control] = await Promise.all([requestValue(snapshots.get(SNAPSHOT_KEY)), requestValue(meta.get(CONTROL_KEY))]);
    const snapshot: OfflineSnapshot | undefined = snapshotRow?.value;
    if (validGeneration(control) === expectedGeneration && snapshot && utcMillis(snapshot.expiresAt) <= Date.now()) {
      nextGeneration = expectedGeneration + 1;
      snapshots.clear();
      tx.objectStore("receipts").clear();
      meta.put({ key: CONTROL_KEY, generation: nextGeneration, disabled: true,
        quarantinedIdentity: { actorId: snapshot.actorId, organizationId: snapshot.organizationId, eventId: snapshot.eventId, venueId: snapshot.venueId, reason: "snapshot_expired" },
        lastSeenActorId: snapshot.actorId, lastSeenOrganizationId: snapshot.organizationId });
      expired = true;
    }
    await done(tx);
  } finally { db.close(); }
  if (expired) { try { const channel = new BroadcastChannel("tsudoi-offline"); channel.postMessage({ type: "expired", generation: nextGeneration }); channel.close(); } catch { /* optional */ } }
  return expired;
}

export async function appendOfflineOperation(operation: OfflineOperation) {
  const db = await openDb();
  try {
    const tx = db.transaction(["snapshots", "operations", "meta"], "readwrite");
    const snapshots = tx.objectStore("snapshots"), operations = tx.objectStore("operations"), meta = tx.objectStore("meta");
    const [snapshotRow, current, control] = await Promise.all([requestValue(snapshots.get(SNAPSHOT_KEY)), requestValue(operations.getAll()), requestValue(meta.get(CONTROL_KEY))]);
    const snapshot: OfflineSnapshot | undefined = snapshotRow?.value;
    if (!snapshot) { tx.abort(); throw new Error("オフライン受付の準備データがありません。"); }
    if (utcMillis(snapshot.expiresAt) <= Date.now()) { tx.abort(); throw new Error("準備データの有効期限が切れています。新しい操作は追加できません。"); }
    if (current.length >= MAX_OPERATIONS) { tx.abort(); throw new Error("未同期操作が上限の500件に達しました。先に同期または書き出しをしてください。"); }
    if (operation.eventId !== snapshot.eventId || !snapshot.attendees.some((person) => person.id === operation.attendeeId)) { tx.abort(); throw new Error("操作対象が準備データと一致しません。状態を再読み込みしてください。"); }
    if (operation.type === "presence" && operation.payload.venueId !== snapshot.venueId) { tx.abort(); throw new Error("入退館会場が準備データと一致しません。"); }
    if (operation.type === "distribution" && (!operation.distributionId || !snapshot.distributions.some((round) => round.id === operation.distributionId))) { tx.abort(); throw new Error("配布回が準備データに含まれていません。"); }
    const attendee = snapshot.attendees.find((person) => person.id === operation.attendeeId)!;
    if (operation.payload.credentialHash && !attendee.credentials.some((credential) => credential.credentialHash === operation.payload.credentialHash && utcMillis(credential.expiresAt) > Date.now())) { tx.abort(); throw new Error("QR確認情報が準備データと一致しないか、有効期限が切れています。"); }
    if (current.some((row) => row.requestId === operation.requestId)) { tx.abort(); throw new Error("この操作はすでに保存されています。"); }
    const nextSequence = (control?.nextSequence ?? 0) + 1;
    if (operation.type === "distribution" && operation.distributionId) {
      const round = snapshot.distributions.find((item) => item.id === operation.distributionId)!;
      const base = attendee.distributionUsage.find((usage) => usage.distributionId === operation.distributionId)?.used ?? 0;
      const existing = current.filter((row) => row.type === "distribution" && row.distributionId === operation.distributionId && row.attendeeId === operation.attendeeId);
      if (existing.some((row) => row.status === "needs_review" && row.reason !== "limit_reached")) { tx.abort(); throw new Error("この参加者の配布操作に要照合があります。先にオンラインで確認してください。"); }
      const reserved = existing.filter((row) => row.status === "pending" || row.status === "retry_only").reduce((sum, row) => sum + Number(row.payload.quantity ?? 0), 0);
      const quantity = Number(operation.payload.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || base + reserved + quantity > round.maxPerAttendee) { tx.abort(); throw new Error("別のタブの操作を含めると配布上限を超えます。残数を再確認してください。"); }
    }
    if (operation.type === "presence") {
      const prior = current.filter((row) => row.type === "presence" && row.attendeeId === operation.attendeeId).sort((a, b) => a.sequence - b.sequence);
      if (prior.some((row) => row.status !== "pending")) { tx.abort(); throw new Error("この参加者には要照合の入退館操作があります。確認するまで追加できません。"); }
      let state = attendee.presence.state, venueId = attendee.presence.venueId, revision = attendee.presence.revision;
      for (const row of prior) {
        const action = row.payload.action;
        if (Number(row.payload.expectedRevision) !== revision) { tx.abort(); throw new Error("入退館の操作順が一致しません。状態を再読み込みしてください。"); }
        if (action === "enter" && state === "out") { state = "in"; venueId = snapshot.venueId; revision += 1; }
        else if (action === "exit" && state === "in" && venueId === snapshot.venueId) { state = "out"; venueId = null; revision += 1; }
        else { tx.abort(); throw new Error("この参加者には現在の状態と合わない入退館操作があります。"); }
      }
      const action = operation.payload.action;
      if (Number(operation.payload.expectedRevision) !== revision || !((action === "enter" && state === "out") || (action === "exit" && state === "in" && venueId === snapshot.venueId))) {
        tx.abort(); throw new Error("別のタブの入退館操作があります。状態を再読み込みしてください。");
      }
    }
    operations.add({ ...operation, sequence: nextSequence });
    meta.put({ ...control, key: CONTROL_KEY, generation: validGeneration(control), nextSequence, disabled: false, quarantinedIdentity: control?.quarantinedIdentity ?? null });
    await done(tx);
  } finally { db.close(); }
}

export async function recordOfflineOutcome(
  requestId: string,
  expectedGeneration: number,
  expectedCreatedAt: string,
  expectedActorId: string,
  expectedOrganizationId: string,
  result: { kind: "accepted" | "needs_review"; outcome: string; summary: string; presence?: OfflineAttendee["presence"]; used?: number; remaining?: number },
) {
  const db = await openDb();
  try {
    const tx = db.transaction(["snapshots", "operations", "receipts", "meta"], "readwrite");
    const snapshots = tx.objectStore("snapshots"), operations = tx.objectStore("operations"), receipts = tx.objectStore("receipts"), meta = tx.objectStore("meta");
    const [operation, control] = await Promise.all([requestValue(operations.get(requestId)), requestValue(meta.get(CONTROL_KEY))]) as [OfflineOperation | undefined, { generation?: number; quarantinedIdentity?: OfflineState["quarantinedIdentity"] } | undefined];
    const snapshotIdentity = control?.quarantinedIdentity ?? (await requestValue(snapshots.get(SNAPSHOT_KEY)))?.value;
    if (validGeneration(control) !== expectedGeneration || !operation || operation.createdAt !== expectedCreatedAt
      || snapshotIdentity?.actorId !== expectedActorId || snapshotIdentity?.organizationId !== expectedOrganizationId) { tx.abort(); throw new Error("操作または利用者が別タブで変更されました。状態を再読み込みしてください。"); }
    const snapshotRow = await requestValue(snapshots.get(SNAPSHOT_KEY));
    const snapshot: OfflineSnapshot | undefined = snapshotRow?.value;
    if (snapshot && result.presence) {
      snapshot.attendees = snapshot.attendees.map((attendee) => attendee.id === operation.attendeeId ? { ...attendee, presence: result.presence! } : attendee);
      snapshots.put({ key: SNAPSHOT_KEY, value: snapshot });
    }
    if (snapshot && operation.type === "distribution" && operation.distributionId && result.used !== undefined && result.remaining !== undefined) {
      snapshot.attendees = snapshot.attendees.map((attendee) => attendee.id === operation.attendeeId
        ? { ...attendee, distributionUsage: [...attendee.distributionUsage.filter((usage) => usage.distributionId !== operation.distributionId), { distributionId: operation.distributionId!, used: result.used!, remaining: result.remaining! }] }
        : attendee);
      snapshots.put({ key: SNAPSHOT_KEY, value: snapshot });
    }
    if (result.kind === "accepted") operations.delete(requestId);
    else operations.put({ ...operation, status: "needs_review", reason: result.outcome });
    receipts.put({ requestId, attendeeId: operation.attendeeId, type: operation.type, outcome: result.outcome, completedAt: new Date().toISOString(), summary: result.summary } satisfies OfflineReceipt);
    if (await requestValue(receipts.count()) > MAX_RECEIPTS) {
      const old = await requestValue(receipts.index("completedAt").openCursor());
      if (old) receipts.delete(old.primaryKey);
    }
    await done(tx);
  } finally { db.close(); }
}

export async function markOfflineNeedsReview(requestId: string, expectedGeneration: number, expectedCreatedAt: string, reason: string) {
  await setOfflineStatus(requestId, expectedGeneration, expectedCreatedAt, "needs_review", reason);
}

export async function setOfflineStatus(requestId: string, expectedGeneration: number, expectedCreatedAt: string, status: OfflineOperation["status"], reason: string) {
  const db = await openDb();
  try {
    const tx = db.transaction(["operations", "meta"], "readwrite");
    const store = tx.objectStore("operations"), meta = tx.objectStore("meta");
    const [operation, control] = await Promise.all([requestValue(store.get(requestId)), requestValue(meta.get(CONTROL_KEY))]) as [OfflineOperation | undefined, { generation?: number } | undefined];
    if (validGeneration(control) !== expectedGeneration || !operation || operation.createdAt !== expectedCreatedAt) { tx.abort(); throw new Error("操作または利用者が別タブで変更されました。状態を再読み込みしてください。"); }
    store.put({ ...operation, status, reason });
    await done(tx);
  } finally { db.close(); }
}

export async function purgeOfflineData() {
  const db = await openDb();
  let generation = 1;
  try {
    const tx = db.transaction(["snapshots", "operations", "receipts", "meta"], "readwrite");
    const meta = tx.objectStore("meta"), control = await requestValue(meta.get(CONTROL_KEY));
    generation = validGeneration(control) + 1;
    tx.objectStore("snapshots").clear(); tx.objectStore("operations").clear(); tx.objectStore("receipts").clear();
    meta.put({ key: CONTROL_KEY, generation, disabled: true });
    await done(tx);
  } finally { db.close(); }
  try { const channel = new BroadcastChannel("tsudoi-offline"); channel.postMessage({ type: "purged", generation }); channel.close(); } catch { /* optional */ }
  return generation;
}

export async function quarantineIfIdentityChanged(actorId: string, organizationId: string) {
  const db = await openDb();
  let changed: { generation: number; actorId: string; organizationId: string } | null = null;
  try {
    const tx = db.transaction(["snapshots", "receipts", "meta"], "readwrite");
    const snapshots = tx.objectStore("snapshots"), receipts = tx.objectStore("receipts"), meta = tx.objectStore("meta");
    const [snapshotRow, control] = await Promise.all([requestValue(snapshots.get(SNAPSHOT_KEY)), requestValue(meta.get(CONTROL_KEY))]);
    const snapshot: OfflineSnapshot | undefined = snapshotRow?.value;
    if (snapshot && (snapshot.actorId !== actorId || snapshot.organizationId !== organizationId)) {
      const generation = validGeneration(control) + 1;
      snapshots.clear();
      receipts.clear();
      meta.put({ key: CONTROL_KEY, generation, disabled: true,
        quarantinedIdentity: { actorId: snapshot.actorId, organizationId: snapshot.organizationId, eventId: snapshot.eventId, venueId: snapshot.venueId, reason: "identity_changed" }, lastSeenActorId: actorId, lastSeenOrganizationId: organizationId });
      changed = { generation, actorId: snapshot.actorId, organizationId: snapshot.organizationId };
    } else if (!snapshot && control?.quarantinedIdentity && (control.lastSeenActorId !== actorId || control.lastSeenOrganizationId !== organizationId)) {
      const generation = validGeneration(control) + 1;
      meta.put({ ...control, generation, lastSeenActorId: actorId, lastSeenOrganizationId: organizationId,
        quarantinedIdentity: { ...control.quarantinedIdentity, reason: "identity_changed" } });
      changed = { generation, actorId: control.quarantinedIdentity.actorId, organizationId: control.quarantinedIdentity.organizationId };
    }
    await done(tx);
  } finally { db.close(); }
  if (changed) { try { const channel = new BroadcastChannel("tsudoi-offline"); channel.postMessage({ type: "quarantined", generation: changed.generation }); channel.close(); } catch { /* optional */ } }
}

export function exportPendingOperations(state: OfflineState) {
  return {
    format: "tsudoi-offline-operations-v1",
    exportedAt: new Date().toISOString(),
    prepared: state.snapshot ? { eventName: state.snapshot.eventName, venueName: state.snapshot.venueName, expiresAt: state.snapshot.expiresAt } : null,
    operations: state.operations.map(({ requestId, eventId, distributionId, attendeeId, type, payload, createdAt, status, reason }) => ({ requestId, eventId, distributionId, attendeeId, type,
      payload: Object.fromEntries(Object.entries(payload).filter(([key]) => ["requestId", "attendeeId", "action", "venueId", "expectedRevision", "occurredAt", "quantity"].includes(key))), createdAt, status, reason })),
    receipts: state.receipts.map(({ requestId, attendeeId, type, outcome, completedAt, summary }) => ({ requestId, attendeeId, type, outcome, completedAt, summary })),
  };
}

export function disableServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve();
  return navigator.serviceWorker.getRegistrations().then(async (registrations) => {
    await Promise.all(registrations.filter((registration) => new URL(registration.scope).origin === location.origin).map((registration) => registration.unregister()));
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("tsudoi-static-shell-")).map((name) => caches.delete(name)));
  });
}
