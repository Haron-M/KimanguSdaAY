/*
 * ai-format.js  -  turns the AI's text into clean, styled chat HTML.
 * Include it BEFORE your chat script:  <script src="ai-format.js"></script>
 * Then use:  bubble.innerHTML = formatAiReply(fullText);
 *
 * Handles: headings (bold), numbered points, bullets, Bible citations in
 * italic + colour, and removes any stray * # | --- or <br> the model may leak.
 */
(function () {
    // ---- Styles (injected automatically, change the colours here) ----
    var css = [
        '.ai-h{font-weight:700;font-size:1.02em;margin:12px 0 4px;color:inherit}',
        '.ai-h:first-child{margin-top:0}',
        '.ai-p{margin:6px 0;line-height:1.55}',
        '.ai-li{display:flex;gap:8px;margin:5px 0;line-height:1.55}',
        '.ai-n{flex:0 0 auto;min-width:18px;font-weight:700;color:#f59e0b}',
        '.ai-ref{font-style:italic;color:#1d6fb8}',
        '.ai-note{margin-top:8px;font-size:.9em;opacity:.7}'
    ].join('');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Inline formatting. Runs AFTER escaping.
    function inline(s) {
        return s
            .replace(/\[\[(.+?)\]\]/g, '<em class="ai-ref">$1</em>')              // [[John 3:16]] -> italic colour
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')                       // **bold** -> bold
            .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, '$1<em class="ai-ref">$2</em>') // *italic*
            .replace(/[*`]/g, '');                                                  // remove any leftover marks
    }

    window.formatAiReply = function (text) {
        var lines = String(text || '')
            .replace(/\r/g, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .split('\n');

        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // horizontal rules and table separator rows
            if (/^[-\u2013\u2014_=*\s|:]{3,}$/.test(line)) continue;

            // table rows -> one readable line
            if (line.charAt(0) === '|') {
                line = line.split('|').map(function (c) { return c.trim(); })
                    .filter(Boolean).join(' \u2013 ');
                if (!line) continue;
            }

            var m;

            // headings: "## Title", "#### Title"
            if ((m = line.match(/^#{1,6}\s*(.+)$/))) {
                out.push('<div class="ai-h">' + inline(esc(m[1].replace(/\*+/g, ''))) + '</div>');
                continue;
            }

            // numbered points: "1. text" or "1) text"
            if ((m = line.match(/^(\d{1,2})[.)]\s+(.+)$/))) {
                out.push('<div class="ai-li"><span class="ai-n">' + m[1] + '.</span><span>' +
                    inline(esc(m[2])) + '</span></div>');
                continue;
            }

            // bullets: "- text", "* text", "\u2022 text"
            if ((m = line.match(/^[-*\u2022]\s+(.+)$/))) {
                out.push('<div class="ai-li"><span class="ai-n">\u2022</span><span>' +
                    inline(esc(m[1])) + '</span></div>');
                continue;
            }

            // trailing notice from the server, e.g. (This answer was long...)
            if (/^\(.*\)$/.test(line) && /continue|interrupted/i.test(line)) {
                out.push('<div class="ai-note">' + esc(line) + '</div>');
                continue;
            }

            out.push('<div class="ai-p">' + inline(esc(line)) + '</div>');
        }
        return out.join('');
    };
})();

/*
 * ---------- HOW TO USE IN YOUR CHAT CODE ----------
 *
 * Streaming reply:
 *
 *   const res = await fetch('/api/ai/chat', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
 *       body: JSON.stringify({ message })
 *   });
 *   const reader = res.body.getReader();
 *   const decoder = new TextDecoder();
 *   let full = '';
 *   while (true) {
 *       const { done, value } = await reader.read();
 *       if (done) break;
 *       full += decoder.decode(value, { stream: true });
 *       botBubble.innerHTML = formatAiReply(full);      // <-- NOT textContent
 *       chatBox.scrollTop = chatBox.scrollHeight;
 *   }
 *
 * Saved history (when the chat opens):
 *
 *   msg.role === 'assistant'
 *       ? bubble.innerHTML = formatAiReply(msg.content)
 *       : bubble.textContent = msg.content;             // keep the member's own text as plain text
 */