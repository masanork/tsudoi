<script lang="ts">
  import type { FormAnswers, FormField } from "./form-fields";

  export let fields: FormField[] = [];
  export let answers: FormAnswers = {};

  function options(field: FormField): string[] {
    try {
      const value: unknown = JSON.parse(field.options_json);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  }
  function text(key: string, values: FormAnswers) {
    const value = values[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  function setValue(key: string, value: string | number | boolean | string[] | undefined) {
    const next = { ...answers };
    if (value === undefined) delete next[key];
    else next[key] = value;
    answers = next;
  }
  function selected(key: string, values: FormAnswers): string[] {
    const value = values[key];
    return Array.isArray(value) ? value : [];
  }
  function toggle(key: string, option: string, checked: boolean) {
    const values = selected(key, answers);
    setValue(key, checked ? [...new Set([...values, option])] : values.filter((value) => value !== option));
  }
</script>

{#each fields as field (field.field_key)}
  {@const required = field.required === 1}
  {#if field.field_type === "multi_select"}
    <fieldset>
      <legend>{field.label}{required ? "（必須）" : ""}</legend>
      {#each options(field) as option, index}
        <label class="inline"><input type="checkbox" checked={selected(field.field_key, answers).includes(option)} required={required && selected(field.field_key, answers).length === 0 && index === 0} onchange={(event) => toggle(field.field_key, option, event.currentTarget.checked)} />{option}</label>
      {/each}
    </fieldset>
  {:else if field.field_type === "checkbox" || field.field_type === "consent"}
    <label class="inline"><input type="checkbox" checked={answers[field.field_key] === true} required={required} onchange={(event) => setValue(field.field_key, event.currentTarget.checked)} />{field.label}{required ? "（必須）" : ""}</label>
  {:else}
    <label>{field.label}{required ? "（必須）" : ""}
      {#if field.field_type === "textarea"}
        <textarea value={text(field.field_key, answers)} required={required} oninput={(event) => setValue(field.field_key, event.currentTarget.value || undefined)}></textarea>
      {:else if field.field_type === "single_select"}
        <select aria-label={`${field.label}${required ? "（必須）" : ""}`} value={text(field.field_key, answers)} required={required} onchange={(event) => setValue(field.field_key, event.currentTarget.value || undefined)}>
          <option value="">選択してください</option>
          {#each options(field) as option}<option value={option}>{option}</option>{/each}
        </select>
      {:else if field.field_type === "number"}
        <input type="number" step="any" value={text(field.field_key, answers)} required={required} oninput={(event) => setValue(field.field_key, event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)} />
      {:else}
        <input type={field.field_type === "date" ? "date" : "text"} value={text(field.field_key, answers)} required={required} oninput={(event) => setValue(field.field_key, event.currentTarget.value || undefined)} />
      {/if}
    </label>
  {/if}
{/each}
