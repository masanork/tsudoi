<script lang="ts">
  import { onMount } from "svelte";
  import type { FormField } from "./form-fields";
  type Field = FormField & { id: string; revision: number; retired_at: string | null; staff_visibility: string; sort_order: number; searchable: number };
  export let eventId: string;
  export let api: (path: string, init?: RequestInit) => Promise<unknown>;
  export let onchange: () => Promise<void>;
  let fields: Field[] = [];
  let editing = "", label = "", choices = "", required = false, adminOnly = false, order = 0;
  let message = "", busy = false, templateName = "", templateId = "";
  let templates: Array<{ id: string; name: string; field_count: number }> = [];
  let loadRevision = 0;
  onMount(() => { void load().catch(failed); });
  function failed(error: unknown) {
    const code = error instanceof Error ? error.message : "";
    message = code.includes("field_conflict") ? "別の変更がありました。また、使用済みの選択肢は削除できません。項目を読み直して確認してください。"
      : code.includes("template_field_key_conflict") ? "同じ項目キーがあるため、追加できません。既存の項目は変更していません。"
      : "操作を完了できませんでした。入力内容を確認して再試行してください。";
  }
  async function load() {
    const revision = ++loadRevision;
    const [loaded, result] = await Promise.all([api(`/events/${eventId}/form-fields?includeRetired=true`), api("/form-templates")]);
    if (revision !== loadRevision) return;
    fields = loaded as Field[]; templates = (result as { templates: typeof templates }).templates;
  }
  function begin(field: Field) { editing = field.id; label = field.label; choices = (JSON.parse(field.options_json) as string[]).join("\n"); required = field.required === 1; adminOnly = field.staff_visibility === "admin_only"; order = field.sort_order; message = ""; }
  async function change(field: Field, patch: Record<string, unknown>) {
    busy = true; message = "";
    try {
      await api(`/events/${eventId}/form-fields/${field.id}`, { method: "PATCH", body: JSON.stringify({ revision: field.revision, ...patch }) });
      editing = ""; await Promise.all([load(), onchange()]); message = "項目を更新しました。既存の回答は保持されています。";
    } catch (error) { failed(error); await load().catch(failed); }
    finally { busy = false; }
  }
  async function save(field: Field) {
    await change(field, { label, required, staffVisibility: adminOnly ? "admin_only" : "visible", sortOrder: order,
      options: ["single_select", "multi_select"].includes(field.field_type) ? choices.split("\n").map((item) => item.trim()).filter(Boolean) : [] });
  }
  async function saveTemplate() {
    busy = true;
    try { await api(`/events/${eventId}/form-templates`, { method: "POST", body: JSON.stringify({ name: templateName }) }); templateName = ""; await load(); message = "項目テンプレートを保存しました。参加者の情報は含まれません。"; }
    catch (error) { failed(error); } finally { busy = false; }
  }
  async function applyTemplate() {
    if (!window.confirm("選択したテンプレートの項目を追加します。参加者情報のコピーは行いません。同じ項目キーがある場合は全体を中止します。")) return;
    busy = true;
    try { await api(`/events/${eventId}/form-templates/${templateId}/apply`, { method: "POST" }); await Promise.all([load(), onchange()]); message = "テンプレートの項目を追加しました。"; }
    catch (error) { failed(error); } finally { busy = false; }
  }
  async function deleteTemplate() {
    if (!window.confirm("このテンプレートを削除します。すでに追加したイベントの項目と回答は保持されます。")) return;
    busy = true;
    try { await api(`/form-templates/${templateId}`, { method: "DELETE" }); templateId = ""; await load(); message = "テンプレートを削除しました。"; }
    catch (error) { failed(error); } finally { busy = false; }
  }
</script>

<details class="workflow-panel" ontoggle={(event) => { if (event.currentTarget.open) void load().catch(failed); }}>
  <summary>登録済み項目の変更・廃止</summary>
  <p class="muted">廃止すると新しい申込では表示されなくなり、既存の回答は名簿とCSVに残ります。使用済みの選択肢は削除できません。</p>
  {#each fields as field (field.id)}
    <div class="field-setting">
      <strong>{field.label}{field.retired_at ? "（廃止済み）" : ""}</strong>
      <button type="button" class="quiet" disabled={busy} onclick={() => begin(field)}>項目を変更</button>
      <button type="button" class="quiet" disabled={busy} onclick={() => void change(field, { retired: !field.retired_at })}>{field.retired_at ? "申込に戻す" : "申込から外す"}</button>
      {#if editing === field.id}<form class="form-grid" onsubmit={(event) => { event.preventDefault(); void save(field); }}><fieldset disabled={busy}>
        <legend>{field.label}の設定</legend>
        <label>項目名<input bind:value={label} maxlength="200" required /></label>
        <label>表示順<input type="number" bind:value={order} min="0" max="10000" required /></label>
        {#if ["single_select", "multi_select"].includes(field.field_type)}<label>選択肢（1行に1つ）<textarea bind:value={choices} required></textarea></label>{/if}
        <label class="inline"><input type="checkbox" bind:checked={required} />回答を必須にする</label>
        <label class="inline"><input type="checkbox" bind:checked={adminOnly} />回答の閲覧・編集を管理者に限定する</label>
        <button>項目の変更を保存</button><button class="quiet" type="button" onclick={() => editing = ""}>編集を閉じる</button>
      </fieldset></form>{/if}
    </div>
  {/each}
</details>
<details class="workflow-panel"><summary>項目テンプレート</summary>
  <p class="muted">この組織の別のイベントで申込項目を再利用できます。氏名・連絡先・回答は保存しません。</p>
  <form onsubmit={(event) => { event.preventDefault(); void saveTemplate(); }}><label>テンプレート名<input bind:value={templateName} maxlength="100" required /></label><button disabled={busy}>現在の項目をテンプレートに保存</button></form>
  <label>利用するテンプレート<select aria-label="利用するテンプレート" bind:value={templateId}><option value="">選択してください</option>{#each templates as template}<option value={template.id}>{template.name}（{template.field_count}項目）</option>{/each}</select></label>
  <button type="button" disabled={busy || !templateId} onclick={() => void applyTemplate()}>テンプレートの項目を追加</button>
  <button type="button" class="quiet" disabled={busy || !templateId} onclick={() => void deleteTemplate()}>テンプレートを削除</button>
</details>
{#if message}<p class="notice" role="status">{message}</p>{/if}
