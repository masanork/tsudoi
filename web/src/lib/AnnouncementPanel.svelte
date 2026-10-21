<script lang="ts">
  export let eventId: string;
  export let api: (path: string, init?: RequestInit) => Promise<unknown>;
  let subject = "", body = "", message = "", busy = false;
  let preview: { subject: string; body: string; recipients: number } | null = null;
  async function checkRecipients() {
    busy = true; message = ""; preview = null;
    try { const draft = { subject, body }; const result = await api(`/events/${eventId}/announcements`, { method: "POST", body: JSON.stringify({ subject: draft.subject, message: draft.body, preview: true }) }) as { recipients: number }; preview = { ...draft, recipients: result.recipients }; }
    catch { message = "送信対象を確認できませんでした。入力内容と通信を確認してください。"; } finally { busy = false; }
  }
  async function send() {
    if (!preview || preview.subject !== subject || preview.body !== body) return;
    busy = true; message = "";
    try { const result = await api(`/events/${eventId}/announcements`, { method: "POST", body: JSON.stringify({ subject, message: body }) }) as { queued: number }; subject = ""; body = ""; preview = null; message = `${result.queued}件のメール送信を予約しました。`; }
    catch { preview = null; message = "送信予約を完了できませんでした。一部が予約されている可能性があるため、再送前に状況を確認してください。"; } finally { busy = false; }
  }
</script>
<section aria-labelledby="announcement"><h2 id="announcement">参加者へ案内</h2>
  <p>有効な参加者のうち、メールアドレスを登録した方へ送ります。同じメールアドレスへの送信は1件にまとめます。</p>
  <form onsubmit={(event) => { event.preventDefault(); void checkRecipients(); }}><fieldset disabled={busy}><legend>案内メール</legend>
    <label>件名<input bind:value={subject} maxlength="160" required /></label><label>本文<textarea bind:value={body} maxlength="5000" required></textarea></label><button>送信対象を確認</button>
  </fieldset></form>
  {#if preview && preview.subject === subject && preview.body === body}<p>{preview.recipients}件のメールアドレスが対象です。</p><button type="button" disabled={busy || preview.recipients === 0} onclick={() => void send()}>参加者へのメール送信を予約</button>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}
</section>
