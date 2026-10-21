<script lang="ts">
  import FieldInputs from "./FieldInputs.svelte";
  import type { FormAnswers, FormField } from "./form-fields";
  export let eventId: string;
  export let attendees: Array<{ id: string; name: string; revision?: number }>;
  export let fields: FormField[];
  export let venues: Array<{ id: string; name: string }>;
  export let api: (path: string, init?: RequestInit) => Promise<unknown>;
  export let onchange: () => Promise<void>;
  let kind = "affiliation", affiliation = "", venueId = "", fieldKey = "", answers: FormAnswers = {}, busy = false, message = "";
  $: chosenFields = fields.filter((field) => field.field_key === fieldKey);
  async function save() {
    const value = answers[fieldKey];
    const patch = kind === "affiliation" ? { affiliation } : kind === "venue" ? { venueId: venueId || null } : { answers: { [fieldKey]: value ?? null } };
    if (kind === "answer" && !fieldKey) return;
    if (!window.confirm(`${attendees.length}人の${kind === "affiliation" ? "所属" : kind === "venue" ? "会場" : chosenFields[0]?.label}を変更します。空欄は現在の値を消去します。保存してよろしいですか。`)) return;
    busy = true; message = "";
    try { await api(`/events/${eventId}/roster/bulk-update`, { method: "POST", body: JSON.stringify({ attendees: attendees.map((person) => ({ id: person.id, revision: person.revision })), patch }) }); await onchange(); }
    catch (error) { const code = error instanceof Error ? error.message : ""; message = code.includes("bulk_conflict") ? "変更された参加者、受付済みの会場変更、または項目変更があるため、全員の更新を中止しました。名簿を読み直して確認してください。" : "一括更新できませんでした。入力内容を確認してください。"; }
    finally { busy = false; }
  }
</script>
<div class="workflow-panel" aria-label="選択した参加者の一括更新">
  <h3>{attendees.length}人を一括更新</h3><p>{attendees.map((person) => person.name).join("、")}</p>
  <p class="muted">1回100人まで。同時編集などの競合があると全員の更新を中止します。</p>
  <form onsubmit={(event) => { event.preventDefault(); void save(); }}><fieldset disabled={busy}>
    <legend>変更内容</legend><label>変更する項目<select aria-label="変更する項目" bind:value={kind} onchange={() => { answers = {}; }}><option value="affiliation">所属</option><option value="venue">会場</option><option value="answer">カスタム回答</option></select></label>
    {#if kind === "affiliation"}<label>一括設定する所属<input bind:value={affiliation} maxlength="200" /></label>
    {:else if kind === "venue"}<label>一括設定する会場<select aria-label="一括設定する会場" bind:value={venueId}><option value="">未割当</option>{#each venues as venue}<option value={venue.id}>{venue.name}</option>{/each}</select></label>
    {:else}<label>回答項目<select aria-label="回答項目" bind:value={fieldKey} onchange={() => { answers = {}; }} required><option value="">選択してください</option>{#each fields as field}<option value={field.field_key}>{field.label}</option>{/each}</select></label><FieldInputs fields={chosenFields} bind:answers />{/if}
    <button disabled={attendees.length > 100}>選択した参加者を更新</button>
  </fieldset></form>
  {#if message}<p class="notice" role="status">{message}</p>{/if}
</div>
