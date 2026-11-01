using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;

namespace Muse2Api;

/// <summary>DOM selectors and in-page scripts for the muse.ai web client,
/// ported from Python <c>drivers/browser/dom.py</c>.
/// All knowledge about the page structure lives here; when muse.ai ships a
/// UI change, this is normally the only file that needs updating.</summary>
public static class Dom
{
    public const string Input = "textarea";
    public const string AgentBubble = "div[class*=\"hatch-agent-bubble-bg\"]";
    public const string Attachment = "[data-testid^=\"hatch-chat-attachment-presentation-\"]";
    public const string StopButton = "button[aria-label*=\"Stop\" i]";
    public const string ApprovalCard = "[data-testid=\"hatch-inline-approval-card\"]";
    public const string FileInput = "input[type=\"file\"]";

    public static readonly string[] LoginHints = { "log in", "sign in", "create an account", "use another account" };
    public static readonly string[] QuotaHints = { "out of credits", "usage limit", "limit reached", "token limit" };
    public static readonly string[] StallHints = { "Still sending", "Connecting..." };

    public static string Q(string value) => JsonSerializer.Serialize(value);

    public static readonly string PageState = $$"""
        (() => {
          const body = document.body ? document.body.innerText : '';
          const hydration = document.querySelector('[data-hatch-shell-hydration-state]');
          return {
            ready: document.readyState === 'complete' && !!document.querySelector({{Q(Input)}})
                   && (!hydration || hydration.getAttribute('data-hatch-shell-hydration-state') === 'hydrated')
                   && !body.includes('Connecting...'),
            hasInput: !!document.querySelector({{Q(Input)}}),
            path: location.pathname,
            head: body.slice(0, 800),
          };
        })()
        """;

    public static readonly string ChatState = ReadChatState();

    /// <summary>
    /// Trích TOÀN BỘ lịch sử hội thoại của trang thread hiện tại
    /// (v0.8.8, cho endpoint thread-messages). Dùng ĐÚNG selector đã
    /// có: bubble trợ lý (<see cref="AgentBubble"/>) → role
    /// "assistant", nhóm user ([class~="group/msg"] có ms-auto +
    /// items-end và KHÔNG chứa agent bubble) → role "user"; text
    /// bằng ĐÚNG hàm replyText của <see cref="ChatState"/> (kèm khôi
    /// phục fence code cho &lt;pre&gt;&lt;code&gt;). Các ứng viên
    /// được sắp theo thứ tự tài liệu (compareDocumentPosition) rồi
    /// loại ứng viên lồng trong ứng viên khác, nên thứ tự user →
    /// agent trên trang được giữ nguyên. Trả { messages: [{ role,
    /// content }], title: document.title thô } — title thô do C#
    /// làm sạch bằng DiagnosticLines.CleanThreadTitle, không làm
    /// sạch ở đây để logic tiêu đề chung chỉ nằm một chỗ.
    /// </summary>
    public static readonly string ThreadHistory = $$"""
        (() => {
          const visible = e => e.getClientRects().length > 0
            && !e.closest('[hidden],[aria-hidden="true"],[inert]')
            && getComputedStyle(e).visibility !== 'hidden';
          // Bản sao nguyên văn replyText của ChatState: <pre><code>
          // đã render không còn fence Markdown nên khôi phục lại
          // trước khi trả về.
          const replyText = node => {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const tag = node.tagName;
            if (['BUTTON', 'SVG', 'SCRIPT', 'STYLE'].includes(tag) || node.getAttribute('aria-hidden') === 'true') return '';
            if (tag === 'PRE') {
              const code = node.querySelector('code') || node;
              const language = (code.className || '').match(/(?:language|lang)-([\w-]+)/)?.[1]
                || code.getAttribute('data-language') || node.getAttribute('data-language') || '';
              return '\n```' + language + '\n' + (code.textContent || '') + '\n```\n';
            }
            if (tag === 'BR') return '\n';
            const body = [...node.childNodes].map(replyText).join('');
            return ['DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'H1', 'H2', 'H3'].includes(tag) ? body + '\n' : body;
          };
          const bubbles = [...document.querySelectorAll({{Q(AgentBubble)}})].filter(visible);
          const groups = [...document.querySelectorAll('[class~="group/msg"]')].filter(visible);
          const users = groups.filter(e => e.classList.contains('ms-auto') && e.classList.contains('items-end') && !e.querySelector({{Q(AgentBubble)}}));
          const candidates = bubbles.map(el => ({ el, role: 'assistant' }))
            .concat(users.map(el => ({ el, role: 'user' })));
          candidates.sort((a, b) => {
            if (a.el === b.el) return 0;
            const p = a.el.compareDocumentPosition(b.el);
            if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });
          const outer = candidates.filter(c => !candidates.some(o => o !== c && o.el.contains(c.el)));
          const messages = outer.map(c => ({ role: c.role, content: replyText(c.el).trim() }));
          return { messages, title: (document.title || '') };
        })()
        """;

    public static string ReadChatState(string? localRequestId = null) => $$"""
        (() => {
          const visible = e => e.getClientRects().length > 0
            && !e.closest('[hidden],[aria-hidden="true"],[inert]')
            && getComputedStyle(e).visibility !== 'hidden';
          // A rendered <pre><code> no longer contains Markdown fences.
          // Reconstruct them before returning tool JSON to the local executor.
          const replyText = node => {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const tag = node.tagName;
            if (['BUTTON', 'SVG', 'SCRIPT', 'STYLE'].includes(tag) || node.getAttribute('aria-hidden') === 'true') return '';
            if (tag === 'PRE') {
              const code = node.querySelector('code') || node;
              const language = (code.className || '').match(/(?:language|lang)-([\w-]+)/)?.[1]
                || code.getAttribute('data-language') || node.getAttribute('data-language') || '';
              return '\n```' + language + '\n' + (code.textContent || '') + '\n```\n';
            }
            if (tag === 'BR') return '\n';
            const body = [...node.childNodes].map(replyText).join('');
            return ['DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'H1', 'H2', 'H3'].includes(tag) ? body + '\n' : body;
          };
          const scrollers = [...document.querySelectorAll('*')].filter(e => {
            const s = getComputedStyle(e);
            return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 50;
          });
          scrollers.forEach(e => { e.scrollTop = e.scrollHeight; });
          const bubbles = [...document.querySelectorAll({{Q(AgentBubble)}})].filter(visible);
          const last = bubbles.length ? replyText(bubbles[bubbles.length - 1]).trim() : '';
          // The site can render a branch with the same bubble count and the
          // same JSON as the previous branch. Establish provenance after the
          // new user message instead of mistaking equal text for an old reply.
          const ids = window.__museReplyNodeIds ||= { nodes: new WeakMap(), next: 1 };
          const nodeId = e => { if (!e) return ''; if (!ids.nodes.has(e)) ids.nodes.set(e, String(ids.next++)); return ids.nodes.get(e); };
          const groups = [...document.querySelectorAll('[class~="group/msg"]')].filter(visible);
          const users = groups.filter(e => e.classList.contains('ms-auto') && e.classList.contains('items-end') && !e.querySelector({{Q(AgentBubble)}}));
          const user = users.length ? users[users.length - 1] : null;
          const agent = bubbles.length ? bubbles[bubbles.length - 1] : null;
          const userText = user ? replyText(user).trim() : '';
          let fingerprint = 2166136261;
          for (let i=0;i<userText.length;i++) fingerprint = Math.imul(fingerprint ^ userText.charCodeAt(i), 16777619);
          const userKey = user ? userText.length + ':' + (fingerprint >>> 0) : '';
          const replyAfterUser = !!(user && agent && (user.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING));
          const requestId = {{Q(localRequestId ?? "")}};
          const owner = requestId ? users.find(e => (e.textContent || '').includes('MUSE_LOCAL_REQUEST_ID: ' + requestId)) : null;
          const follows = (a,b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
          // Never bind a historical assistant node to a new local submission,
          // even when hydration/reordering changes its text or bubble count.
          const localReplies = owner ? bubbles.filter(b => follows(owner,b)
            && !users.some(u => u !== owner && follows(owner,u) && follows(u,b))) : [];
          const localReply = localReplies.length ? localReplies[localReplies.length-1] : null;
          const localReplyText = localReply ? replyText(localReply).trim() : '';
          const atts = [...document.querySelectorAll({{Q(Attachment)}})].map(a => {
            const v = a.querySelector('video'), i = a.querySelector('img');
            const m = v || i;
            return {
              tid: a.getAttribute('data-testid') || '',
              kind: v ? 'video' : (i ? 'image' : 'unknown'),
              src: m ? (m.currentSrc || m.src || '') : '',
              w: m ? (m.videoWidth || m.naturalWidth || 0) : 0,
              h: m ? (m.videoHeight || m.naturalHeight || 0) : 0,
            };
          });
          const tail = document.body ? document.body.innerText.slice(-600) : '';
          const rateLimited = [...document.querySelectorAll('[role="alert"]')].some(e =>
            e.getClientRects().length > 0 && /too many requests|rate limit|sending (?:messages|requests) too (?:fast|quickly)/i.test(e.textContent || ''));
          const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
          const generating = buttons.some(b => !b.disabled && /^(stop(?: generating| generation| response)?|dừng(?: tạo| phản hồi)?|停止(?:生成)?)(?:[.!…\s]*)$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
          const error = [...document.querySelectorAll('[role="alert"]')].filter(visible)
            .map(e => e.innerText || '').find(t => /something went wrong|failed to (?:send|generate)|connection (?:lost|failed)|network error|đã xảy ra lỗi/i.test(t)) || '';
          return { agentCount: bubbles.length, lastText: last, replyKey: nodeId(agent), replyKeys: bubbles.map(nodeId), userKey, replyAfterUser, rateLimited, error,
                    localRequestId: requestId, localReplyBound: !!localReply, localReplyText,
                    generating,
                    approval: [...document.querySelectorAll({{Q(ApprovalCard)}})].some(visible),
                    attachments: atts, tail };
        })()
        """;

    public static readonly string DenyApprovals = $$"""
        (() => {
          const denied = [];
          for (const card of document.querySelectorAll({{Q(ApprovalCard)}})) {
            const btn = [...card.querySelectorAll('button,[role=button]')]
              .find(b => /^(deny|decline|reject|don.t allow)$/i.test((b.innerText || '').trim()));
            if (btn && !btn.disabled) {
              btn.click();
              denied.push(card.getAttribute('aria-label') || 'approval request');
            }
          }
          return denied;
        })()
        """;

    public static readonly string LastBubbleMedia = $$"""
        (() => {
          const bubbles = [...document.querySelectorAll({{Q(AgentBubble)}})];
          const b = bubbles.length ? bubbles[bubbles.length - 1] : null;
          if (!b) return { links: [], html: '' };
          const urls = [];
          const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };
          b.querySelectorAll('video, source').forEach(m => push(m.currentSrc || m.src || ''));
          b.querySelectorAll('a[href]').forEach(a => push(a.href || ''));
          b.querySelectorAll('img').forEach(m => push(m.currentSrc || m.src || ''));
          const text = b.innerText || '';
          const re = /https?:\/\/[^\s)<>"']+/g;
          let mm; while ((mm = re.exec(text))) push(mm[0]);
          return { links: urls, html: (b.outerHTML || '').slice(0, 2000) };
        })()
        """;

    public static string FillInput(string text) => $$"""
        (() => {
          const ta = document.querySelector({{Q(Input)}});
          if (!ta) return { ok: false, err: 'no-input' };
          ta.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, {{Q(text)}});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, len: ta.value.length };
        })()
        """;

    public const string ClickSend = """
        (() => {
          const btn = [...document.querySelectorAll('button,[role=button]')]
            .filter(b => b.offsetParent !== null)
            .find(b => /send|发送/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')));
          if (!btn) return 'missing';
          if (btn.disabled) return 'disabled';
          btn.click();
          return 'clicked';
        })()
        """;

    public static readonly string InputEmpty = $"!(document.querySelector({Q(Input)}) || {{value: ''}}).value";

    public static string AttachFile(string b64, string mime, string filename) => $$"""
        (() => {
          try {
            const input = document.querySelector({{Q(FileInput)}});
            if (!input) return { ok: false, err: 'no-file-input' };
            const bin = atob({{Q(b64)}});
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], {{Q(filename)}}, { type: {{Q(mime)}} }));
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          } catch (e) { return { ok: false, err: String(e) }; }
        })()
        """;

    public static string FetchAsBase64(string url) => $$"""
        (async () => {
          try {
            const r = await fetch({{Q(url)}});
            const b = await r.blob();
            const buf = new Uint8Array(await b.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return { ok: true, mime: b.type || '', b64: btoa(s) };
          } catch (e) { return { ok: false, err: String(e) }; }
        })()
        """;

    // --- quota (Settings menu) ---
    public static readonly string[] SettingsLabels = { "Settings", "設定", "设置" };
    public const string SettingsDock = "[data-testid=\"hatch-dock-more\"]";

    public static readonly string QuotaSettingsEntry = $$"""
        (() => {
          const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
          const labels = {{JsonSerializer.Serialize(SettingsLabels)}};
          const b = [...document.querySelectorAll({{Q(SettingsDock)}})].find(visible)
            || [...document.querySelectorAll('button,[role=button]')].find(e =>
                 visible(e) && labels.includes((e.getAttribute('aria-label') || '').trim()));
          if (!b) return null; const r = b.getBoundingClientRect();
          return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
        })()
        """;

    public static readonly string QuotaMenuItem = $$"""
        (() => {
          const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
          const labels = {{JsonSerializer.Serialize(SettingsLabels)}};
          const exact = e => labels.includes((e.textContent || '').trim());
          const b = [...document.querySelectorAll('[role=menuitem]')].find(e =>
              visible(e) && (exact(e) || [...e.querySelectorAll('span,div')].some(exact)))
            || [...document.querySelectorAll('[role=menu] button,[role=menu] span,[role=menu] div')]
                 .find(e => visible(e) && exact(e));
          if (!b) return null; const r = b.getBoundingClientRect();
          return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
        })()
        """;

    public const string QuotaDialogText = """
        (() => {
          const d = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')]
            .find(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');
          return d ? (d.innerText || '') : '';
        })()
        """;

    // --- quota text parsing (English / zh-CN / zh-TW), ported from dom.py ---
    private static readonly string[] UsageHeadings = { "usage", "用量", "使用量" };
    private static readonly string[] LanguageHeadings = { "language", "语言", "語言" };
    private static readonly Regex PlanRe = new(@"^.{1,60}?(?:\s+plan|計劃|计划|方案)$", RegexOptions.IgnoreCase);
    private static readonly Regex ResetEn = new(@"Weekly limit resets? on ([^\n]+)", RegexOptions.IgnoreCase);
    private static readonly Regex ResetZh = new(@"(?:每(?:週|周|星期)|週|周)(?:上限|限額|限额|額度|额度)(?:會|会|將|将)?(?:於|于|在)\s*([^\n]+?)\s*(?:重設|重置)");
    private static readonly Regex ExtraRe = new(@"^(?:(?:Additional|Extra)\s+tokens|(?:額外|额外)(?:的)?(?:符元|符記|代幣|代币|令牌|憑證|凭证|tokens))", RegexOptions.IgnoreCase);
    private static readonly Regex PctUsed = new(@"(\d+(?:\.\d+)?)\s*%\s*(?:used\b|已(?:使)?用)", RegexOptions.IgnoreCase);
    private static readonly Regex UsedPct = new(@"已(?:使)?用\s*(\d+(?:\.\d+)?)\s*%");

    private static double? ParseUsedPct(string line)
    {
        var m = PctUsed.Match(line);
        if (!m.Success) m = UsedPct.Match(line);
        if (!m.Success) return null;
        if (!double.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var v)) return null;
        return v is >= 0 and <= 100 ? v : null;
    }

    public static Dictionary<string, object?> ParseUsageText(string? text)
    {
        var normalized = (text ?? "").Normalize(System.Text.NormalizationForm.FormKC);
        var lines = normalized.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        var start = lines.FindIndex(l => UsageHeadings.Contains(l.ToLowerInvariant()));
        if (start >= 0) lines = lines.Skip(start + 1).ToList();
        var end = lines.FindIndex(l => LanguageHeadings.Contains(l.ToLowerInvariant()));
        if (end >= 0) lines = lines.Take(end).ToList();
        var joined = string.Join("\n", lines);

        string? plan = lines.FirstOrDefault(l => PlanRe.IsMatch(l));
        string? resets = null;
        var rm = ResetEn.Match(joined);
        if (!rm.Success) rm = ResetZh.Match(joined);
        if (rm.Success) resets = rm.Groups[1].Value.Trim();
        var extraAt = lines.FindIndex(l => ExtraRe.IsMatch(l));
        if (extraAt < 0) extraAt = lines.Count;
        double? weekly = null;
        foreach (var ln in lines.Take(extraAt))
            if (ParseUsedPct(ln) is { } v) { weekly = v; break; }
        string? extraLeft = null;
        foreach (var ln in lines.Skip(extraAt))
        {
            if (ParseUsedPct(ln) is null) continue;
            var lm = Regex.Match(ln, @"\(([^)]+)\)");
            if (lm.Success) extraLeft = lm.Groups[1].Value.Trim();
            break;
        }
        return new Dictionary<string, object?>
        {
            ["plan"] = plan, ["weekly_used_pct"] = weekly, ["resets_at"] = resets,
            ["extra_left"] = extraLeft, ["found"] = weekly is not null,
        };
    }
}
