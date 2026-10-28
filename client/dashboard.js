// ===================== SERVER API =====================
// The browser never talks to the database. Everything goes through your Node server.
// Local development: server on port 5000. In production set API_BASE to your server's
// address (use '' if the server also serves this page).
// Change API_BASE_URL to API_BASE
// Define base URL without trailing /api to prevent doubling
const API_BASE = window.location.hostname === 'localhost'
    ? 'http://localhost:5000'
    : '';

const TOKEN_KEYS = ['token', 'access_token', 'authToken', 'kimangu_token'];
const REFRESH_KEY = 'refresh_token';

// ===================== ASK AI CHAT =====================
const aiFab = document.getElementById('aiFab');
const aiPanel = document.getElementById('aiPanel');
const aiMessages = document.getElementById('aiMessages');
const aiInput = document.getElementById('aiInput');
const aiSend = document.getElementById('aiSend');
const aiBody = document.getElementById('aiBody');
let aiLoaded = false;
let aiBusy = false;

const AI_AVATAR_SRC = 'images/chatbot.png';   // use '/images/chatbot.png' if the page loads from another folder
const AI_SUGGESTIONS = ['What events are coming up?', 'Give me a Bible verse for today', 'How do I make a payment?'];

// ---------- Speech-bubble tail pointing at the bot image ----------
(function aiInjectStyles() {
    const css = `
        .ai-row.bot { align-items: flex-start; }
        .ai-row.bot > .ai-msg.bot {
            position: relative;
            margin-left: 6px;
            border-top-left-radius: 14px;
        }
        .ai-row.bot > .ai-msg.bot::before {
            content: '';
            position: absolute;
            left: -7px;
            top: 11px;
            width: 12px;
            height: 12px;
            background: #fff;
            border-left: 1px solid #e2e8f0;
            border-bottom: 1px solid #e2e8f0;
            transform: rotate(45deg);
        }
        .ai-row.bot > .ai-msg.bot.error::before { border-color: #fecaca; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
})();

// ---------- Reference styling safety net ----------
// The app colours anything the AI wraps in [[double brackets]]. The AI sometimes forgets
// the brackets, so any Bible reference (John 3:16, 2 Peter 2:15, Numbers 25) or Ellen G. White
// citation (Desire of Ages p 234.3, The Adventist Home, p. 45) that is still unwrapped gets
// wrapped here before formatting. References the AI already wrapped are left untouched.
const AI_BIBLE_NUMBERED = '[1-3]\\s+(?:Samuel|Kings|Chronicles|Corinthians|Thessalonians|Timothy|Peter|John)';
const AI_BIBLE_BOOKS = 'Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Song of Solomon|Song of Songs|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Galatians|Ephesians|Philippians|Colossians|Titus|Philemon|Hebrews|James|Jude|Revelation';
const AI_VERSES = '\\s+\\d{1,3}(?::\\d{1,3}(?:[-\u2013\u2014]\\d{1,3})?)?(?:,\\s*\\d{1,3}(?![\\d:])(?:[-\u2013\u2014]\\d{1,3})?)*(?!\\d)';
const AI_EGW_BARE_TITLES = "(?:The\\s+)?(?:Desire of Ages|Steps to Christ|Great Controversy|Patriarchs and Prophets|Prophets and Kings|Acts of the Apostles|Ministry of Healing|Christ['\u2019]s Object Lessons|Thoughts from the Mount of Blessing|Adventist Home|Messages to Young People|Child Guidance|Counsels on Health|Counsels on Diet and Foods|Early Writings|Selected Messages)";
const AI_EGW_ALL_TITLES = "(?:The\\s+)?(?:Desire of Ages|Steps to Christ|Great Controversy|Patriarchs and Prophets|Prophets and Kings|Acts of the Apostles|Ministry of Healing|Christ['\u2019]s Object Lessons|Thoughts from the Mount of Blessing|Adventist Home|Messages to Young People|Child Guidance|Counsels on Health|Counsels on Diet and Foods|Early Writings|Selected Messages|Testimonies for the Church|Counsels for the Church|Fundamentals of Christian Education|Gospel Workers|Last Day Events|Life Sketches|Education|Evangelism|Temperance)";
const AI_REFERENCE_RX = new RegExp(
    // 1) Ellen G. White title followed by a page, e.g. "Desire of Ages p 234.3" or "The Adventist Home, p. 45"
    AI_EGW_ALL_TITLES + ',?\\s+pp?\\.?\\s*\\d+(?:\\.\\d+)?(?:[-\u2013]\\d+(?:\\.\\d+)?)?' +
    // 2) a bare Ellen G. White title in round brackets, e.g. "(Desire of Ages)"
    '|\\(\\s*' + AI_EGW_BARE_TITLES + '\\s*\\)' +
    // 3) a Bible reference, e.g. "John 3:16", "1 Thessalonians 4:3\u20135", "Numbers 25"
    '|\\b(?:' + AI_BIBLE_NUMBERED + '|' + AI_BIBLE_BOOKS + ')' + AI_VERSES,
    'g'
);

function aiWrapReferences(text) {
    // Odd-numbered pieces are the AI's own [[wrapped]] references: leave them exactly as they are
    return String(text).split(/(\[\[[\s\S]*?\]\])/).map((part, i) => {
        if (i % 2 === 1) return part;
        return part.replace(AI_REFERENCE_RX, (m) =>
            m.charAt(0) === '(' ? '([[' + m.slice(1, -1).trim() + ']])' : '[[' + m + ']]');
    }).join('');
}

// Bot answers are drawn as formatted HTML (headings, numbering, italic references).
// Everything else (member messages, errors, welcome text) stays plain text.
function aiRender(el, text) {
    el.innerHTML = formatAiReply(aiWrapReferences(text));
}

// ---------- Smooth reveal ----------
// Text from the server is queued and shown a few characters per screen frame, so even a
// big chunk appears progressively. When the network is slow, the text follows it.
function aiCreateTypewriter(el) {
    const MIN_PER_FRAME = 2;       // base speed: about 120 characters per second
    const CATCH_UP_DIVISOR = 18;   // the bigger the backlog, the faster it catches up

    let target = '';        // everything received from the server so far
    let shown = 0;          // how many characters are on screen
    let finished = false;   // the network stream has ended
    let cancelled = false;
    let rafId = 0;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });

    function visibleText() {
        const part = target.slice(0, shown);
        if (finished && shown >= target.length) return part;
        // Hide a half-typed [[Bible reference]] until its closing brackets are shown
        const open = part.lastIndexOf('[[');
        return (open !== -1 && part.indexOf(']]', open) === -1) ? part.slice(0, open) : part;
    }

    function schedule() {
        if (!rafId && !cancelled) rafId = requestAnimationFrame(tick);
    }

    function tick() {
        rafId = 0;
        if (cancelled) return;

        const backlog = target.length - shown;
        if (backlog > 0) {
            shown = Math.min(target.length, shown + Math.max(MIN_PER_FRAME, Math.ceil(backlog / CATCH_UP_DIVISOR)));
            aiRender(el, visibleText());
            aiMessages.scrollTop = aiMessages.scrollHeight;
        }

        if (shown < target.length) {
            schedule();                          // more to reveal
        } else if (finished) {
            aiRender(el, target);                // final draw of the complete text
            aiMessages.scrollTop = aiMessages.scrollHeight;
            resolveDone();                       // everything shown and the stream is over
        }
        // otherwise wait: push() restarts the loop when more text arrives
    }

    return {
        push(text) { target += text; schedule(); },
        finish() { finished = true; schedule(); },
        cancel() {
            cancelled = true;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = 0;
            resolveDone();
        },
        done
    };
}

// ---------- Bot avatar ----------
function aiMakeAvatar() {
    const img = document.createElement('img');
    img.className = 'ai-avatar';
    img.src = AI_AVATAR_SRC;
    img.alt = 'AI assistant';
    // if the image cannot load, show the amber icon instead
    img.addEventListener('error', () => {
        const fb = document.createElement('div');
        fb.className = 'ai-avatar ai-avatar-fallback';
        fb.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
        img.replaceWith(fb);
    });
    return img;
}

// ---------- Recent chats (saved in this browser) ----------
function aiChatsKey() { return `kimangu_ai_chats_v2_${currentUserId}`; }
const AI_MAX_CHATS = 30;
let aiChats = [];          // [{ id, title, updated, messages: [{ role, content }] }]
let aiCurrentId = null;
function aiStoreRead() {
    aiChats = [];
    aiCurrentId = null;                 // never keep another user's chats in memory
    if (!currentUserId) return;
    try {
        const d = JSON.parse(localStorage.getItem(aiChatsKey()) || 'null');
        if (d && Array.isArray(d.chats)) {
            aiChats = d.chats;
            aiCurrentId = d.currentId || null;
        }
    } catch (e) { /* ignore */ }
}

function aiStoreWrite() {
    if (!currentUserId) return;
    aiChats.sort((a, b) => b.updated - a.updated);
    aiChats = aiChats.slice(0, AI_MAX_CHATS);
    try {
        localStorage.setItem(aiChatsKey(), JSON.stringify({ chats: aiChats, currentId: aiCurrentId }));
    } catch (e) { /* ignore */ }
}

function aiCurrentChat() {
    return aiChats.find(c => c.id === aiCurrentId) || null;
}

function aiCreateChat() {
    const c = {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: 'New chat',
        updated: Date.now(),
        messages: []
    };
    aiChats.unshift(c);
    aiCurrentId = c.id;
    return c;
}

function aiRecord(role, content) {
    const c = aiCurrentChat() || aiCreateChat();
    c.messages.push({ role, content });
    if (role === 'user' && c.title === 'New chat') c.title = content.slice(0, 40);
    c.updated = Date.now();
    aiStoreWrite();
}

// ---------- Messages ----------
function aiAddMessage(role, text, extraClass = '', rich = false) {
    const el = document.createElement('div');
    el.className = `ai-msg ${role} ${extraClass}`.trim();
    if (rich && role === 'bot') {
        el.classList.add('ai-rich');
        aiRender(el, text);
    } else {
        el.textContent = text;
    }

    if (role === 'bot') {
        // avatar on the left, bubble (with its tail) pointing at it
        const row = document.createElement('div');
        row.className = 'ai-row bot';
        row.appendChild(aiMakeAvatar());
        row.appendChild(el);
        aiMessages.appendChild(row);
    } else {
        aiMessages.appendChild(el);
    }
    aiMessages.scrollTop = aiMessages.scrollHeight;
    return el;   // returns the bubble, so the typewriter works on it directly
}

function aiShowWelcome() {
    aiMessages.innerHTML = '';
    const name = (typeof greetingName !== 'undefined' && greetingName) ? greetingName : 'there';
    aiAddMessage('bot', `Hi ${name}! Welcome to Ask AI. Ask me anything about the Bible, Adventist beliefs, or how to use this platform.`);
    const wrap = document.createElement('div');
    wrap.className = 'ai-suggest';
    AI_SUGGESTIONS.forEach(q => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = q;
        b.addEventListener('click', () => { aiInput.value = q; aiSendMessage(); });
        wrap.appendChild(b);
    });
    aiMessages.appendChild(wrap);
}

function aiRenderChat(chat) {
    aiMessages.innerHTML = '';
    if (!chat || !chat.messages.length) { aiShowWelcome(); return; }
    chat.messages.forEach(m => {
        if (m.role === 'user') aiAddMessage('user', m.content);
        else aiAddMessage('bot', m.content, '', true);   // formatted
    });
}

async function aiLoadHistory() {
    if (!currentUserId) { aiShowWelcome(); return; }   // profile not loaded yet: try again on the next open
    if (aiLoaded) return;
    aiLoaded = true;
    aiStoreRead();

    // first time on this device: import whatever the server already has as the first chat
    if (!aiChats.length) {
        try {
            const rows = await api('/api/ai/history');
            if (Array.isArray(rows) && rows.length) {
                const c = aiCreateChat();
                rows.forEach(r => c.messages.push({ role: r.role === 'user' ? 'user' : 'bot', content: r.content }));
                const firstUser = c.messages.find(m => m.role === 'user');
                if (firstUser) c.title = firstUser.content.slice(0, 40);
                aiStoreWrite();
            }
        } catch (err) { /* fall through to welcome */ }
    }

    const cur = aiCurrentChat();
    if (cur && cur.messages.length) aiRenderChat(cur);
    else aiShowWelcome();
}

// ---------- Recent chats sidebar ----------
function aiHistoryIsOpen() {
    return !!aiBody && aiBody.classList.contains('history-open');
}

function aiHistoryToggle(open) {
    if (!aiBody) return;
    aiBody.classList.toggle('history-open', open);
    const btn = document.getElementById('aiHistoryBtn');
    const side = document.getElementById('aiHistory');
    if (btn) btn.setAttribute('aria-expanded', String(open));
    if (side) side.setAttribute('aria-hidden', String(!open));
    if (open) aiRenderHistoryList();
}

function aiTimeLabel(ts) {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function aiRenderHistoryList() {
    const list = document.getElementById('aiHistoryList');
    if (!list) return;
    aiStoreRead();                                   // pick up changes from other tabs
    list.innerHTML = '';

    const chats = aiChats.filter(c => c.messages.length);
    if (!chats.length) {
        const empty = document.createElement('div');
        empty.className = 'ai-history-empty';
        empty.textContent = 'No recent chats yet.';
        list.appendChild(empty);
        return;
    }

    chats.forEach(c => {
        const item = document.createElement('div');
        item.className = 'ai-history-item' + (c.id === aiCurrentId ? ' active' : '');

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'ai-history-open';
        const title = document.createElement('span');
        title.className = 'ai-history-title';
        title.textContent = c.title;
        const time = document.createElement('span');
        time.className = 'ai-history-time';
        time.textContent = aiTimeLabel(c.updated);
        open.append(title, time);
        open.addEventListener('click', () => {
            if (aiBusy) return;
            aiCurrentId = c.id;
            aiStoreWrite();
            aiRenderChat(c);
            aiHistoryToggle(false);
        });

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ai-history-del';
        del.setAttribute('aria-label', 'Delete chat');
        del.innerHTML = '<i class="fa-solid fa-trash"></i>';
        del.addEventListener('click', () => {
            if (aiBusy || !confirm('Delete this chat?')) return;
            aiChats = aiChats.filter(x => x.id !== c.id);
            if (aiCurrentId === c.id) { aiCurrentId = null; aiShowWelcome(); }
            aiStoreWrite();
            aiRenderHistoryList();
        });

        item.append(open, del);
        list.appendChild(item);
    });
}

function aiStartNewChat() {
    if (aiBusy) return;
    aiCurrentId = null;                 // the chat is created when the first message is sent
    aiStoreWrite();
    aiShowWelcome();
    aiHistoryToggle(false);
    api('/api/ai/history', { method: 'DELETE' }).catch(() => { });   // fresh context on the server
}

// One delegated listener handles the three dots, the dark backdrop and "New chat".
// It works no matter when those elements were created.
document.addEventListener('click', (e) => {
    if (e.target.closest('#aiHistoryBtn')) {
        aiHistoryToggle(!aiHistoryIsOpen());
    } else if (e.target.closest('#aiHistoryBackdrop')) {
        aiHistoryToggle(false);
    } else if (e.target.closest('#aiNewChat')) {
        aiStartNewChat();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aiHistoryIsOpen()) aiHistoryToggle(false);
});

// ---------- Open / close ----------
function aiOpen() {
    aiPanel.classList.add('open');
    aiFab.classList.add('hidden');
    aiLockPage(true);
    aiFitToViewport();
    aiLoadHistory();
    setTimeout(() => aiInput.focus({ preventScroll: true }), 50);
}
function aiClose() {
    aiHistoryToggle(false);
    aiPanel.classList.remove('open', 'kb-open');
    aiPanel.style.top = '';
    aiPanel.style.height = '';
    aiPanel.style.transform = '';
    aiFab.classList.remove('hidden');
    aiLockPage(false);
}

// ---------- Mobile keyboard: keep header fixed, input above the keyboard ----------
(function aiInjectKeyboardStyles() {
    const style = document.createElement('style');
    style.textContent = `
        @media (max-width: 768px) {
            html.ai-lock, html.ai-lock body {
                overflow: hidden !important;
                overscroll-behavior: none;
                height: 100%;
            }
            .ai-panel { transition: none; }
        }
    `;
    document.head.appendChild(style);
})();

function aiIsMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
}
function aiFitToViewport() {
    if (!aiPanel.classList.contains('open')) return;

    if (!aiIsMobile()) {
        aiPanel.style.top = '';
        aiPanel.style.height = '';
        aiPanel.style.transform = '';
        aiPanel.classList.remove('kb-open');
        return;
    }

    const vv = window.visualViewport;
    if (!vv) return;

    // Cover exactly the visible area above the keyboard, and follow it if the browser shifts it
    aiPanel.style.top = '0px';
    aiPanel.style.height = Math.floor(vv.height) + 'px';
    aiPanel.style.transform = `translateY(${Math.round(vv.offsetTop)}px)`;

    const keyboardOpen = document.activeElement === aiInput || (window.innerHeight - vv.height) > 120;
    aiPanel.classList.toggle('kb-open', keyboardOpen);

    aiMessages.scrollTop = aiMessages.scrollHeight;
}

function aiLockPage(lock) {
    document.documentElement.classList.toggle('ai-lock', lock && aiIsMobile());
}

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', aiFitToViewport);
    window.visualViewport.addEventListener('scroll', aiFitToViewport);
}
window.addEventListener('resize', aiFitToViewport);
window.addEventListener('orientationchange', () => setTimeout(aiFitToViewport, 300));

// some phones report the new size a moment after the keyboard starts opening
aiInput.addEventListener('focus', () => {
    [100, 350, 700].forEach(ms => setTimeout(aiFitToViewport, ms));
});
aiInput.addEventListener('blur', () => setTimeout(aiFitToViewport, 150));

// ---------- Sending ----------
// Streams the reply from the server (api() only handles JSON, so this uses fetch directly)
async function aiStreamReply(message, retry = true) {
    const res = await fetch(`${API_BASE}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ message, chatId: aiCurrentId })
    });

    if (res.status === 401) {
        if (retry && await refreshSession()) return aiStreamReply(message, false);
        clearSession();
        goToLogin();
        throw new Error('Session expired');
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'The assistant is unavailable right now.');
    }
    return res;
}

async function aiSendMessage() {
    const text = aiInput.value.trim();
    if (!text || aiBusy) return;

    aiBusy = true;
    aiSend.disabled = true;
    aiInput.value = '';
    aiInput.style.height = 'auto';
    aiHistoryToggle(false);

    const suggest = aiMessages.querySelector('.ai-suggest');
    if (suggest) suggest.remove();

    aiAddMessage('user', text);
    aiRecord('user', text);                          // saved to Recent chats
    const bot = aiAddMessage('bot', '', 'ai-typing ai-rich');
    let writer = null;

    try {
        const res = await aiStreamReply(text);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        writer = aiCreateTypewriter(bot);
        let reply = '';

        // Hand every piece of text to the typewriter the moment it arrives
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const piece = decoder.decode(value, { stream: true });
            reply += piece;
            writer.push(piece);
        }
        const tail = decoder.decode();               // flush any last bytes
        if (tail) {
            reply += tail;
            writer.push(tail);
        }

        writer.finish();
        await writer.done;                           // wait until the last character is on screen
        aiMessages.scrollTop = aiMessages.scrollHeight;

        if (!reply.trim()) {
            bot.classList.remove('ai-rich');
            bot.textContent = 'I could not come up with a reply. Please try again.';
        } else {
            aiRecord('bot', reply);                  // saved to Recent chats
        }
    } catch (err) {
        if (writer) writer.cancel();                 // stop the reveal so it cannot overwrite the error
        bot.classList.remove('ai-rich');
        bot.textContent = err.message || 'Something went wrong. Please try again.';
        bot.classList.add('error');
    } finally {
        bot.classList.remove('ai-typing');
        aiBusy = false;
        aiSend.disabled = false;
        aiInput.focus({ preventScroll: true });
    }
}

// ---------- Events ----------
aiFab.addEventListener('click', aiOpen);
document.getElementById('aiClose').addEventListener('click', aiClose);
aiSend.addEventListener('click', aiSendMessage);

aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        aiSendMessage();
    }
});
aiInput.addEventListener('input', () => {
    aiInput.style.height = 'auto';
    aiInput.style.height = Math.min(aiInput.scrollHeight, 96) + 'px';
});

function readLegacySession() {
    for (const key of Object.keys(localStorage)) {
        if (!/^sb-.+-auth-token$/.test(key)) continue;
        try {
            const session = JSON.parse(localStorage.getItem(key));
            if (session && session.access_token) return { key, session };
        } catch (err) { /* ignore */ }
    }
    return null;
}

function getToken() {
    const legacy = readLegacySession();
    if (legacy) return legacy.session.access_token;
    for (const key of TOKEN_KEYS) {
        const value = localStorage.getItem(key);
        if (value) return value;
    }
    return null;
}

function getRefreshToken() {
    const legacy = readLegacySession();
    return (legacy && legacy.session.refresh_token) || localStorage.getItem(REFRESH_KEY);
}

function saveSession(token, refreshToken, expiresAt) {
    const key = TOKEN_KEYS.find(k => localStorage.getItem(k)) || TOKEN_KEYS[0];
    localStorage.setItem(key, token);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);

    const legacy = readLegacySession();
    if (legacy) {
        legacy.session.access_token = token;
        if (refreshToken) legacy.session.refresh_token = refreshToken;
        if (expiresAt) {
            legacy.session.expires_at = expiresAt;
            legacy.session.expires_in = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
        }
        localStorage.setItem(legacy.key, JSON.stringify(legacy.session));
    }
}

function clearSession() {
    TOKEN_KEYS.forEach(key => localStorage.removeItem(key));
    localStorage.removeItem(REFRESH_KEY);
    Object.keys(localStorage)
        .filter(key => /^sb-.+-auth-token$/.test(key))
        .forEach(key => localStorage.removeItem(key));
}

function goToLogin() { window.location.href = 'auth.html'; }

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// One refresh at a time, even if several requests expire together
let refreshing = null;
function refreshSession() {
    if (!refreshing) {
        refreshing = (async () => {
            const refreshToken = getRefreshToken();
            if (!refreshToken) return false;
            try {
                const res = await fetch(`${API_BASE}/api/auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refreshToken })
                });
                if (!res.ok) return false;
                const data = await res.json();
                if (!data.token) return false;
                saveSession(data.token, data.refreshToken, data.expiresAt);
                return true;
            } catch (err) {
                return false;
            }
        })().finally(() => { refreshing = null; });
    }
    return refreshing;
}

// Calls your server with the saved token. A 401 triggers one silent refresh, then sends the user to login.
async function api(path, { method = 'GET', body, retry = true } = {}) {
    const token = getToken();
    if (!token) {
        console.warn('Sending you to the login page: no saved login was found in this browser.');
        goToLogin();
        throw new ApiError('Not signed in', 401);
    }

    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
        if (retry && await refreshSession()) return api(path, { method, body, retry: false });
        console.warn(`Sending you to the login page: the server answered 401 (not signed in) for ${path}.`);
        clearSession();
        goToLogin();
        throw new ApiError('Session expired', 401);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    return data;
}

let homeWelcomeText = 'Good day';
let greetingName = '';
let currentUserId = null;
let activeSchedules = [];
let pendingAvatar = null;

// ===================== DOM REFERENCES =====================
const contentFrame = document.getElementById('contentFrame');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const notifBtn = document.getElementById('notifBtn');
const notifDropdown = document.getElementById('notifDropdown');
const avatarWrap = document.getElementById('avatarWrap');
const avatarPanel = document.getElementById('avatarPanel');
const avatarBox = document.getElementById('topbarAvatarContainer');
const apInput = document.getElementById('apInput');
const apSave = document.getElementById('apSave');
const apStatus = document.getElementById('apStatus');
const adminToggle = document.getElementById('adminToggle');
const adminSubmenu = document.getElementById('adminSubmenu');

// ===================== HELPERS =====================
function getInitials(fullName) {
    if (!fullName) return '--';
    const parts = fullName.trim().split(/\s+/);
    const first = parts[0] ? parts[0][0] : '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTimeAgo(dateString) {
    if (!dateString) return 'Recently';
    const seconds = Math.floor((new Date() - new Date(dateString)) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
}

// ===================== TIME-OF-DAY GREETING =====================
// Edit the text below to change what each period says.
const ICON_SUNRISE = `
            <svg viewBox="0 0 48 48">
                <defs><clipPath id="clipSkyRise"><rect x="0" y="0" width="48" height="36"/></clipPath></defs>
                <g clip-path="url(#clipSkyRise)">
                    <g class="sun-rise">
                        <circle class="sun-halo" cx="24" cy="36" r="16" fill="#fde68a"/>
                        <circle cx="24" cy="36" r="11" fill="#f59e0b"/>
                        <path class="ray-fade" d="M6.7 24L11 26.5M14 16.7L16.5 21M24 14v5M34 16.7L31.5 21M41.3 24L37 26.5" stroke="#f59e0b" stroke-width="2.6" stroke-linecap="round" fill="none"/>
                    </g>
                </g>
                <path d="M5 36h38" stroke="#92400e" stroke-width="2.6" stroke-linecap="round"/>
                <path d="M14 41h20" stroke="#92400e" stroke-opacity=".45" stroke-width="2.4" stroke-linecap="round"/>
            </svg>`;

const ICON_SUN = `
            <svg viewBox="0 0 48 48">
                <g class="sun-float">
                    <circle class="sun-halo" cx="24" cy="24" r="15" fill="#fde68a"/>
                    <path class="sun-rays" d="M36 24h5M32.5 32.5L36 36M24 36v5M15.5 32.5L12 36M12 24H7M15.5 15.5L12 12M24 12V7M32.5 15.5L36 12" stroke="#f59e0b" stroke-width="2.8" stroke-linecap="round" fill="none"/>
                    <circle class="sun-core" cx="24" cy="24" r="8.5" fill="#fbbf24"/>
                </g>
            </svg>`;

const ICON_SUNSET = `
            <svg viewBox="0 0 48 48">
                <defs><clipPath id="clipSkySet"><rect x="0" y="0" width="48" height="36"/></clipPath></defs>
                <g clip-path="url(#clipSkySet)">
                    <g class="sun-set">
                        <circle cx="24" cy="28" r="10" fill="#ea580c"/>
                        <path class="ray-fade" d="M11.9 21L8.4 19M17 15.9L15 12.4M24 14v-4M31 15.9L33 12.4M36.1 21L39.6 19" stroke="#ea580c" stroke-width="2.6" stroke-linecap="round" fill="none"/>
                    </g>
                </g>
                <path d="M5 36h38" stroke="#7c2d12" stroke-width="2.6" stroke-linecap="round"/>
                <path d="M14 41h20" stroke="#7c2d12" stroke-opacity=".45" stroke-width="2.4" stroke-linecap="round"/>
            </svg>`;

const ICON_MOON = `
            <svg viewBox="0 0 24 24">
                <circle class="moon-glow" cx="12" cy="12" r="10" fill="#fde68a"/>
                <path class="moon-body" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#fde68a"/>
                <circle class="star s1" cx="19" cy="4.5" r="1" fill="#fff"/>
                <circle class="star s2" cx="22" cy="8.5" r=".7" fill="#fff"/>
                <circle class="star s3" cx="4.5" cy="5" r=".8" fill="#fff"/>
            </svg>`;

const GREETING_PERIODS = {
    morning: { text: 'Good morning', icon: ICON_SUNRISE },  // 05:00 - 11:59  rising sun
    noon: { text: 'Good noon', icon: ICON_SUN },      // 12:00 - 13:59  bright sun
    afternoon: { text: 'Good afternoon', icon: ICON_SUN },      // 14:00 - 16:59  bright sun
    evening: { text: 'Good evening', icon: ICON_SUNSET },   // 17:00 - 18:59  setting sun
    night: { text: 'Good night', icon: ICON_MOON }      // 19:00 - 04:59  moon
};

function getPeriodKey(date = new Date()) {
    const h = date.getHours();
    if (h >= 5 && h < 12) return 'morning';
    if (h == 12) return 'noon';
    if (h > 12 && h < 16) return 'afternoon';
    if (h >= 16 && h < 19) return 'evening';
    return 'night';
}

function renderGreeting() {
    const key = getPeriodKey();
    const period = GREETING_PERIODS[key];

    homeWelcomeText = greetingName ? `${period.text}, ${greetingName}` : period.text;

    const welcomeNameEl = document.getElementById('welcomeName');
    if (welcomeNameEl) welcomeNameEl.textContent = homeWelcomeText;

    const iconEl = document.getElementById('greetingIcon');
    if (iconEl && iconEl.dataset.period !== key) {
        iconEl.dataset.period = key;
        iconEl.className = `greeting-icon period-${key}`;
        iconEl.innerHTML = period.icon;
        iconEl.title = period.text;
    }
}

// ===================== TREASURY DESK DROPDOWN =====================
function toggleSidebarDropdown(btn) {
    const dropdown = btn.closest('.sidebar-dropdown');
    if (dropdown) dropdown.classList.toggle('active');
}

const treasuryBtn = document.getElementById('treasuryBtn');
if (treasuryBtn) {
    treasuryBtn.addEventListener('click', () => toggleSidebarDropdown(treasuryBtn));
}

// ===================== LOCATION (GPS first, IP fallback) =====================
// 1) Browser position (GPS / Wi-Fi) -> town + county.
// 2) If location is blocked, unsupported or fails -> look up the browser's IP address.
const locElement = document.getElementById('sidebarLocation');
const MARK_IP_LOCATION_AS_APPROX = true; // adds "≈" before an IP-based location; set false to hide it
let locating = false;

function setLocationText(text, tooltip) {
    if (!locElement) return;
    locElement.textContent = `${text} 📍`;
    locElement.title = tooltip || text;
}

function withCounty(name, country) {
    const n = (name || '').trim();
    if (!n) return '';
    if (/county/i.test(n)) return n;
    return (country || '').toUpperCase() === 'KE' ? `${n} County` : n;
}

async function fetchJson(url, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// GPS coordinates -> { place, county, country }
async function reverseGeocode(lat, lon) {
    try {
        const json = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1&accept-language=en`);
        const a = json && json.address;
        if (a) {
            const place = a.suburb || a.neighbourhood || a.village || a.hamlet || a.town || a.city || a.municipality || '';
            const candidates = [a.county, a.state, a.state_district, a.region].filter(Boolean);
            const county = candidates.find(c => /county/i.test(c)) || candidates[0] || '';
            return { place, county, country: (a.country_code || '').toUpperCase() };
        }
    } catch (err) {
        console.warn('Nominatim reverse geocode failed:', err);
    }

    try {
        const d = await fetchJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
        return { place: d.locality || d.city || '', county: d.principalSubdivision || '', country: d.countryCode || '' };
    } catch (err) {
        console.warn('BigDataCloud reverse geocode failed:', err);
    }
    return null;
}

// Browser IP address -> { place, county, country }.
// Asks several free IP services at once and uses the answer most of them agree on.
async function lookupByIP() {
    const providers = [
        async () => {
            const d = await fetchJson('https://ipapi.co/json/');
            if (d.error) throw new Error(d.reason || 'ipapi error');
            return { county: d.region || d.city, country: d.country_code };
        },
        async () => {
            const d = await fetchJson('https://ipwho.is/');
            if (!d.success) throw new Error(d.message || 'ipwho error');
            return { county: d.region || d.city, country: d.country_code };
        },
        async () => {
            const d = await fetchJson('https://get.geojs.io/v1/ip/geo.json');
            return { county: d.region || d.city, country: d.country_code };
        },
        async () => {
            // Without coordinates, BigDataCloud locates the caller by IP address
            const d = await fetchJson('https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en');
            return { county: d.principalSubdivision || d.city, country: d.countryCode };
        }
    ];

    const settled = await Promise.allSettled(providers.map(fn => fn()));
    const votes = new Map();

    settled.forEach((result, order) => {
        if (result.status !== 'fulfilled' || !result.value || !result.value.county) return;
        const key = result.value.county.toLowerCase().replace(/\s*county$/i, '').trim();
        const entry = votes.get(key) || { count: 0, order, value: result.value };
        entry.count += 1;
        votes.set(key, entry);
    });

    if (!votes.size) return null;

    const best = [...votes.values()].sort((a, b) => b.count - a.count || a.order - b.order)[0];
    return { place: '', county: best.value.county, country: best.value.country || '' };
}

// County only (no ward or town): "Bungoma County, KE"
// Saved text: "Area, County, KE"   Shown text: "County, KE" (see countyOnly)
function formatLocation({ place, county, country }) {
    const countyText = withCounty(county, country);
    const area = (place || '').trim();
    const parts = [];

    if (area && area.toLowerCase() !== countyText.toLowerCase()) parts.push(area);
    if (countyText) parts.push(countyText);
    if (country) parts.push(country);
    return parts.join(', ');
}

// Older saved values may still include a ward ("Ward, Bungoma County, KE"): keep from the county onward
function countyOnly(text) {
    const parts = (text || '').split(',').map(part => part.trim()).filter(Boolean);
    const i = parts.findIndex(part => /county/i.test(part));
    if (i > 0) return parts.slice(i).join(', ');
    if (i === -1 && parts.length >= 3) return parts.slice(1).join(', ');   // drop the area
    return parts.join(', ');
}

// ---- Saved location + IP check (the server stores it in the `profiles` table) ----
const ALLOW_SKIP = false;   // true = always offer "Continue with approximate location" on the gate
let gateIP = null;          // IP address seen when the gate was opened
let gateSoftFailures = 0;   // device could not locate (not a permission problem); 2 in a row unlock the skip button

const locGate = document.getElementById('locGate');
const locGateBtn = document.getElementById('locGateBtn');
const locGateHelp = document.getElementById('locGateHelp');
const locGateSkip = document.getElementById('locGateSkip');

function getPosition(options) {
    return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

// Quick network/Wi-Fi fix first (most reliable on laptops), then a high-accuracy GPS fix.
async function getBestPosition() {
    try {
        return await getPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
    } catch (err) {
        if (err.code === 1) throw err; // permission denied: retrying will not help
        return await getPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }
}

async function getGeoPermissionState() {
    try {
        if (navigator.permissions && navigator.permissions.query) {
            return (await navigator.permissions.query({ name: 'geolocation' })).state; // granted | prompt | denied
        }
    } catch (err) { /* not supported */ }
    return 'prompt';
}

// The browser's current public IP address
async function getCurrentIP() {
    const sources = [
        async () => (await fetchJson('https://api.ipify.org?format=json')).ip,
        async () => (await fetchJson('https://ipwho.is/')).ip,
        async () => (await fetchJson('https://ipapi.co/json/')).ip
    ];
    for (const get of sources) {
        try {
            const ip = await get();
            if (ip) return ip;
        } catch (err) {
            console.warn('IP address lookup failed:', err);
        }
    }
    return null;
}

async function loadStoredLocation() {
    try {
        return await api('/api/profile/location');
    } catch (err) {
        console.warn('Could not read the saved location:', err.message);
        return null;
    }
}

async function persistLocation(text, source, ip) {
    if (!currentUserId) return;
    try {
        await api('/api/profile/location', { method: 'PUT', body: { text, source, ip: ip || null } });
    } catch (err) {
        console.warn('Could not save the location:', err.message);
    }
}

// Exact position from the browser -> "Town, County, KE". Throws if it cannot.
async function fetchExactLocation() {
    const position = await getBestPosition();
    const info = await reverseGeocode(position.coords.latitude, position.coords.longitude);
    const text = info ? formatLocation(info) : '';
    if (!text) throw new Error('Could not look up the town');
    return text;
}

function locationLabel(text, source) {
    return (source === 'ip' && MARK_IP_LOCATION_AS_APPROX ? '≈ ' : '') + countyOnly(text);
}

// "How to turn location on" depends on the device: mobile browsers have no address-bar shortcut
function getLocationHelpText() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);

    if (isIOS) {
        return 'Location is blocked. Open your phone Settings, go to Privacy & Security, then Location Services, turn it on and allow your browser to use it. Come back here and press the button again.';
    }
    if (isAndroid) {
        return 'Location is blocked. Swipe down and turn on Location, then Come back here and press the button again.';
    }
    return 'Location is blocked for this site. Click the lock icon in the address bar, set Location to Allow, then press the button again.';
}

function showGate() {
    locGate.hidden = false;
    locGateSkip.hidden = !(ALLOW_SKIP || gateSoftFailures >= 2);
}

function hideGate() { locGate.hidden = true; }

function setGateHelp(msg) {
    locGateHelp.textContent = msg || '';
    locGateHelp.hidden = !msg;
}

async function finishLocation(text, source, ip) {
    setLocationText(locationLabel(text, source), `${countyOnly(text)}: saved to your profile. Click to refresh.`);
    hideGate();
    await persistLocation(text, source, ip);
}

async function useApproximateLocation(ip) {
    const info = await lookupByIP();
    const text = info ? formatLocation(info) : '';
    if (text) {
        await finishLocation(text, 'ip', ip);
    } else {
        setLocationText('Location unavailable', 'Could not work out your location. Click to retry.');
        hideGate();
    }
}

// Gets a fresh location. If the browser already allows location this happens silently;
// otherwise the full-screen gate opens and stays until the user turns location on.
async function acquireLocation(ip) {
    gateIP = ip;

    if (!('geolocation' in navigator)) {
        await useApproximateLocation(ip);
        return;
    }

    if (await getGeoPermissionState() === 'granted') {
        try {
            await finishLocation(await fetchExactLocation(), 'gps', ip);
            return;
        } catch (err) {
            console.warn('Silent location refresh failed:', err && err.code, err && err.message);
            gateSoftFailures++;
        }
    }

    setLocationText('Location needed');
    locGateBtn.textContent = 'Enable location';
    showGate();
}

// Runs after login: compare the IP with the one saved in the database
async function initLocation() {
    if (!locElement || !currentUserId || locating) return;
    locating = true;
    try {
        setLocationText('Locating…');
        const [currentIP, stored] = await Promise.all([getCurrentIP(), loadStoredLocation()]);
        const hasSaved = !!(stored && stored.location_text);

        // Same IP as last time (or IP unknown) and a saved location: show it from the database
        if (hasSaved && (!currentIP || stored.last_ip === currentIP)) {
            setLocationText(
                locationLabel(stored.location_text, stored.location_source),
                `${countyOnly(stored.location_text)}: saved to your profile. Click to refresh.`
            );
            return;
        }

        // First login, or the IP address changed: location must be fetched again
        await acquireLocation(currentIP);
    } finally {
        locating = false;
    }
}

// Gate button: this click is what makes the browser show its permission prompt
locGateBtn.addEventListener('click', async () => {
    locGateBtn.disabled = true;
    locGateBtn.textContent = 'Getting your location…';
    setGateHelp('');
    try {
        const text = await fetchExactLocation();
        gateSoftFailures = 0;
        await finishLocation(text, 'gps', gateIP || await getCurrentIP());
    } catch (err) {
        console.warn('Location attempt failed:', err && err.code, err && err.message);
        if (err && err.code === 1) {
            setGateHelp(getLocationHelpText());
        } else {
            gateSoftFailures++;
            setGateHelp(
                err && err.code === 2 ? 'Your device could not find its position. Make sure Location is switched on in your device settings, then try again.'
                    : err && err.code === 3 ? 'That took too long. Please try again.'
                        : 'We could not work out your town. Please try again.'
            );
        }
        showGate();
        locGateBtn.textContent = 'Try again';
    } finally {
        locGateBtn.disabled = false;
    }
});

// Safety valve for devices that cannot locate at all (hidden unless needed)
locGateSkip.addEventListener('click', async () => {
    locGateSkip.disabled = true;
    await useApproximateLocation(gateIP || await getCurrentIP());
    locGateSkip.disabled = false;
});

// Clicking the location text in the sidebar refreshes it
if (locElement) {
    locElement.addEventListener('click', async () => {
        if (locating || !currentUserId) return;
        locating = true;
        try {
            setLocationText('Locating…');
            await acquireLocation(await getCurrentIP());
        } finally {
            locating = false;
        }
    });
}

// If the user switches location to Allow while the gate is open, continue automatically
if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' })
        .then((status) => {
            status.onchange = () => {
                if (status.state === 'granted' && !locGate.hidden && !locGateBtn.disabled) locGateBtn.click();
            };
        })
        .catch(() => { /* permissions API not supported */ });
}

// ===================== NOTIFICATIONS (schedules + payments) =====================
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;     // a notification disappears 6 hours after the user saw it
const TOAST_MS = 15 * 1000;                  // login toast stays for 15 seconds
const MAX_LOGIN_TOASTS = 3;                  // more than this are summarised in one extra toast
const PAYMENT_POLL_MS = 30 * 1000;           // how often to ask the server for new deposits
const INCOME_TYPES = new Set(['deposit', 'income', 'revenue']);

let activePayments = [];
let notifSeenKeys = new Set();   // seen while the dropdown is open: keep the unread look until it closes
let notifLoadFailed = false;
let loginToastsShown = false;
let paymentPollTimer = null;

// ---- read / toast bookkeeping (stored per browser) ----
function getReadStorageKey(userId) { return `read_schedules_${userId}`; }

function getReadState(userId) {
    if (!userId) return {};
    try {
        return JSON.parse(localStorage.getItem(getReadStorageKey(userId))) || {};
    } catch (e) {
        return {};
    }
}

function saveReadState(userId, state) {
    if (!userId) return;
    localStorage.setItem(getReadStorageKey(userId), JSON.stringify(state));
}

function getToastedKey(userId) { return `toasted_payments_${userId}`; }

function getToastedState(userId) {
    try {
        return JSON.parse(localStorage.getItem(getToastedKey(userId))) || {};
    } catch (e) {
        return {};
    }
}

function markToasted(userId, keys) {
    const state = getToastedState(userId);
    const now = Date.now();
    keys.forEach(key => { state[key] = now; });
    Object.keys(state).forEach(key => {
        if (now - state[key] > 30 * 24 * 60 * 60 * 1000) delete state[key];
    });
    try { localStorage.setItem(getToastedKey(userId), JSON.stringify(state)); } catch (e) { /* storage full */ }
}

// ---- payment message: identical to the Transaction Log on the My Account Report page ----
function getPaymentAmount(row) {
    const amount = Number(row.amount);
    return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function getPaymentDate(row) {
    const candidates = [
        row.date, row.transaction_date, row.transactionDate,
        row.created_at, row.createdAt, row.timestamp
    ];
    for (const value of candidates) {
        if (!value) continue;
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
}

function formatKSh(value) {
    const number = Number(value) || 0;
    return 'KSh ' + number.toLocaleString('en-KE', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

function formatDateLabel(date) {
    return date
        ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
}

function formatTimeLabel(date) {
    return date
        ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
        : '—';
}

function getTransactionCode(row) {
    const explicit = row.transaction_code || row.transaction_id || row.reference ||
        row.ref_code || row.receipt_no || row.code;
    if (explicit) return String(explicit).toUpperCase();

    const raw = String(row.id ?? '').replace(/-/g, '').toUpperCase();
    return raw ? raw.slice(0, 8) : '—';
}

function isPaymentRow(row) {
    return INCOME_TYPES.has(String(row.type ?? '').trim().toLowerCase());
}

function buildPaymentMessage(row) {
    const date = getPaymentDate(row);
    const amount = formatKSh(getPaymentAmount(row));
    const code = getTransactionCode(row);
    return `Confirmed. Payment of ${amount} on ${formatDateLabel(date)} at ${formatTimeLabel(date)} has been successfully received. Transaction ID ${code}.`;
}

// ---- toast (top right) ----
function showToastCard(title, message) {
    const stack = document.getElementById('payToastStack');
    if (!stack) return;

    const toast = document.createElement('div');
    toast.className = 'pay-toast';
    toast.innerHTML = `
                <div class="pay-toast-icon"><i class="fa-solid fa-arrow-down"></i></div>
                <div class="pay-toast-body">
                    <strong>${escapeHtml(title)}</strong>
                    <p>${escapeHtml(message)}</p>
                </div>
                <button type="button" class="pay-toast-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                <span class="pay-toast-bar"></span>`;

    const remove = () => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 300);
    };
    toast.querySelector('.pay-toast-close').addEventListener('click', remove);
    stack.appendChild(toast);
    setTimeout(remove, TOAST_MS);
}

// Toast a group of payments: the newest few one by one, the rest in a single summary
function toastPayments(rows) {
    if (!currentUserId || !rows.length) return;

    const sorted = rows.slice().sort((a, b) => (getPaymentDate(a) || 0) - (getPaymentDate(b) || 0)); // oldest first

    sorted.slice(-MAX_LOGIN_TOASTS).forEach(row => showToastCard('Payment received', buildPaymentMessage(row)));

    if (sorted.length > MAX_LOGIN_TOASTS) {
        const extra = sorted.length - MAX_LOGIN_TOASTS;
        showToastCard('More payments', `${extra} more payment notification${extra > 1 ? 's are' : ' is'} waiting in your notification bell.`);
    }

    markToasted(currentUserId, sorted.map(row => `pay_${row.id}`));
}

// Payments the user has not seen and has not been toasted about yet (runs once after login)
function showNewPaymentToasts() {
    if (!currentUserId) return;
    const readState = getReadState(currentUserId);
    const toasted = getToastedState(currentUserId);

    toastPayments(activePayments.filter(row =>
        readState[`pay_${row.id}`] === undefined && toasted[`pay_${row.id}`] === undefined
    ));
}

// ---- fetching (through the server) ----
async function fetchAndRenderNotifications(userId) {
    try {
        const [schedulesResult, paymentsResult] = await Promise.allSettled([
            api('/api/notifications'),
            api('/api/payments/recent')
        ]);

        if (schedulesResult.status === 'rejected') console.warn('Could not load schedule notifications:', schedulesResult.reason && schedulesResult.reason.message);
        if (paymentsResult.status === 'rejected') console.warn('Could not load payment notifications:', paymentsResult.reason && paymentsResult.reason.message);

        activeSchedules = schedulesResult.status === 'fulfilled' && Array.isArray(schedulesResult.value) ? schedulesResult.value : [];
        activePayments = paymentsResult.status === 'fulfilled' && Array.isArray(paymentsResult.value) ? paymentsResult.value : [];
        notifLoadFailed = schedulesResult.status === 'rejected' && paymentsResult.status === 'rejected';

        renderNotifications();

        if (!loginToastsShown) {
            loginToastsShown = true;
            showNewPaymentToasts();
        }
        startPaymentPolling();
    } catch (err) {
        console.error('Notification system exception:', err);
    }
}

// New deposits while the dashboard is open: ask the server every 30 seconds
async function pollPayments() {
    if (!currentUserId || document.hidden) return;
    try {
        const rows = await api('/api/payments/recent');
        if (!Array.isArray(rows)) return;

        const known = new Set(activePayments.map(p => String(p.id)));
        const added = rows.filter(row => !known.has(String(row.id)));

        activePayments = rows;
        if (!added.length) return;

        renderNotifications();

        const toasted = getToastedState(currentUserId);
        toastPayments(added.filter(row => toasted[`pay_${row.id}`] === undefined));
    } catch (err) {
        console.warn('Payment check failed:', err.message);
    }
}

function startPaymentPolling() {
    if (paymentPollTimer) return;
    paymentPollTimer = setInterval(pollPayments, PAYMENT_POLL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollPayments(); // catch up when the user returns to the tab
    });
}

// ---- rendering ----
function getNotificationItems() {
    const items = [];

    activeSchedules.forEach(item => {
        items.push({ key: String(item.id), kind: 'schedule', createdAt: item.created_at, data: item });
    });

    activePayments.forEach(row => {
        const date = getPaymentDate(row);
        items.push({ key: `pay_${row.id}`, kind: 'payment', createdAt: date ? date.toISOString() : row.created_at, data: row });
    });

    items.sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
    return items;
}

function scheduleItemHtml(item, unread) {
    const row = item.data;
    const title = row.title || row.duty_name || row.event_title || 'New Schedule Assigned';
    const description = row.description || row.location || (row.date ? `Date: ${row.date}` : 'Check your schedule for details.');

    return `
                <div class="notif-item ${unread ? 'unread' : 'read'}">
                    <div class="notif-icon"><i class="fa-solid fa-calendar-day"></i></div>
                    <div class="notif-content">
                        <p>New schedule: <strong>${escapeHtml(title)}</strong> - ${escapeHtml(description)}</p>
                        <span>${formatTimeAgo(row.created_at)}</span>
                    </div>
                </div>`;
}

function paymentItemHtml(item, unread) {
    const row = item.data;
    return `
                <div class="notif-item ${unread ? 'unread' : 'read'}">
                    <div class="notif-icon pay-notif-icon"><i class="fa-solid fa-arrow-down"></i></div>
                    <div class="notif-content">
                        <p>${escapeHtml(buildPaymentMessage(row))}</p>
                        <span>${formatTimeAgo(item.createdAt)}</span>
                    </div>
                </div>`;
}

function renderNotifications() {
    const notifBadge = document.getElementById('notifBadge');
    const notifList = document.getElementById('notifList');
    if (!notifList || !notifBadge || !currentUserId) return;

    const readState = getReadState(currentUserId);
    const now = Date.now();
    let unreadCount = 0;
    let html = '';

    getNotificationItems().forEach(item => {
        const readAt = readState[item.key];
        const isRead = readAt !== undefined;

        // Seen more than 6 hours ago: gone
        if (isRead && now - readAt >= SIX_HOURS_MS) return;

        if (!isRead) unreadCount++;

        const unreadLook = !isRead || notifSeenKeys.has(item.key);
        html += item.kind === 'payment' ? paymentItemHtml(item, unreadLook) : scheduleItemHtml(item, unreadLook);
    });

    if (unreadCount > 0) {
        notifBadge.textContent = unreadCount;
        notifBadge.style.display = 'inline-block';
    } else {
        notifBadge.textContent = '0';
        notifBadge.style.display = 'none';
    }

    const emptyStyle = 'padding: 1rem; text-align: center; color: #64748b; font-size: 0.85rem;';
    notifList.innerHTML = html ||
        `<div style="${emptyStyle}">${notifLoadFailed ? 'Failed to load notifications.' : 'No new notifications'}</div>`;
}

// Opening the bell = the user has seen everything in it: start the 6 hour countdown
function onNotificationsOpened() {
    if (!currentUserId) return;
    const readState = getReadState(currentUserId);
    const now = Date.now();

    getNotificationItems().forEach(item => {
        if (readState[item.key] === undefined) {
            readState[item.key] = now;
            notifSeenKeys.add(item.key);
        }
    });

    saveReadState(currentUserId, readState);
    renderNotifications(); // badge drops to 0, items keep the unread look while the list is open
}

function onNotificationsClosed() {
    notifSeenKeys.clear();
    renderNotifications();
}

function handleMarkAllAsRead() {
    if (!currentUserId) return;
    const readState = getReadState(currentUserId);
    const now = Date.now();

    getNotificationItems().forEach(item => {
        if (readState[item.key] === undefined) readState[item.key] = now;
    });

    saveReadState(currentUserId, readState);
    notifSeenKeys.clear();
    renderNotifications();
}

const markAllReadBtn = document.getElementById('markAllReadBtn');
if (markAllReadBtn) markAllReadBtn.addEventListener('click', handleMarkAllAsRead);

// ===================== AVATAR & PROFILE =====================
// Topbar + panel preview: uploaded image if it exists, otherwise initials.
// Sidebar avatar: always initials.
function paintAvatar(el, url, initials) {
    if (!el) return;
    if (url && url.trim() !== '') {
        el.innerHTML = `<img src="${escapeHtml(url)}" alt="Profile picture">`;
    } else {
        el.textContent = initials;
    }
}

function updateAvatarUI(avatarUrl, initials) {
    const sidebarEl = document.getElementById('sidebarAvatar');
    if (sidebarEl) sidebarEl.textContent = initials;
    paintAvatar(document.getElementById('topbarAvatar'), avatarUrl, initials);
    paintAvatar(document.getElementById('apPreview'), avatarUrl, initials);
    if (apSave) apSave.textContent = avatarUrl ? 'Change' : 'Upload';
}
// ===================== CHANGE PASSWORD =====================
const pwModal = document.getElementById('pwModal');
const pwForm = document.getElementById('pwForm');
const pwCurrent = document.getElementById('pwCurrent');
const pwNewInput = document.getElementById('pwNewInput');
const pwConfirm = document.getElementById('pwConfirm');
const pwSubmit = document.getElementById('pwSubmit');
const pwError = document.getElementById('pwError');
const pwResult = document.getElementById('pwResult');
let pwDone = false;

function setPwError(msg) {
    pwError.textContent = msg || '';
    pwError.classList.toggle('show', !!msg);
}

function resetPwModal() {
    pwDone = false;
    pwForm.reset();
    [pwCurrent, pwNewInput, pwConfirm].forEach((input) => { input.disabled = false; input.type = 'password'; });
    pwModal.querySelectorAll('.pw-eye').forEach((b) => { b.innerHTML = '<i class="fa-regular fa-eye"></i>'; });
    document.getElementById('pwNew').textContent = '';   // the new password is not kept on the page
    pwResult.hidden = true;
    pwSubmit.disabled = false;
    pwSubmit.textContent = 'Change';
    setPwError('');
}

function openPwModal() {
    closeAvatarPanel();
    resetPwModal();
    pwModal.classList.add('show');
    setTimeout(() => pwCurrent.focus(), 50);
}

function closePwModal() {
    pwModal.classList.remove('show');
    resetPwModal();
}

function passwordIsStrong(p) {
    return p.length >= 6 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);
}

document.getElementById('apChangePw').addEventListener('click', openPwModal);
document.getElementById('pwClose').addEventListener('click', closePwModal);
pwModal.addEventListener('click', (e) => { if (e.target === pwModal) closePwModal(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pwModal.classList.contains('show')) closePwModal();
});

pwModal.querySelectorAll('.pw-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
    });
});

document.getElementById('pwCopy').addEventListener('click', async (e) => {
    try {
        await navigator.clipboard.writeText(document.getElementById('pwNew').textContent);
        e.currentTarget.textContent = 'Copied';
    } catch (err) {
        e.currentTarget.textContent = 'Copy failed';
    }
    setTimeout(() => { document.getElementById('pwCopy').textContent = 'Copy'; }, 1800);
});

pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pwDone) { closePwModal(); return; }   // after success the button reads "Close"
    setPwError('');

    const current = pwCurrent.value;
    const next = pwNewInput.value;
    const confirmValue = pwConfirm.value;

    if (!current) return setPwError('Enter your current password.');
    if (!passwordIsStrong(next)) return setPwError('The new password needs 6+ characters with a lowercase letter, an uppercase letter, a digit and a special character.');
    if (next !== confirmValue) return setPwError('The new passwords do not match.');
    if (next === current) return setPwError('The new password must be different from the current one.');

    pwSubmit.disabled = true;
    pwSubmit.textContent = 'Changing...';

    try {
        await api('/api/profile/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });

        document.getElementById('pwNew').textContent = next;
        pwResult.hidden = false;
        [pwCurrent, pwNewInput, pwConfirm].forEach((input) => { input.value = ''; input.disabled = true; });
        pwDone = true;
        pwSubmit.textContent = 'Close';
    } catch (err) {
        if (err.status === 401) return;   // api() is already sending them to the sign-in page
        setPwError(err.message || 'Could not change the password. Please try again.');
        pwSubmit.textContent = 'Change';
    } finally {
        pwSubmit.disabled = false;
    }
});

// ===================== ROLE-BASED MENU =====================
let currentRole = 'regular';

function normalizeRole(value) {
    const r = String(value || 'regular').toLowerCase().replace(/[\s_-]/g, '');
    if (r === 'superuser') return 'superuser';
    if (r === 'admin') return 'admin';
    if (r === 'treasury') return 'treasury';
    return 'regular';
}

function roleCan(role) {
    return {
        admin: role === 'admin' || role === 'superuser',
        treasury: role === 'treasury' || role === 'superuser',
        material: role === 'superuser'
    };
}

function applyRoleMenu(accountType) {
    currentRole = normalizeRole(accountType);
    const can = roleCan(currentRole);
    document.getElementById('guestFeedbackLink').hidden = !can.material;
    document.getElementById('resetPasswordLink').hidden = !can.material;
    document.getElementById('adminNavGroup').hidden = !can.admin;
    document.getElementById('treasuryDropdown').hidden = !can.treasury;
    document.getElementById('adminMaterialLink').hidden = !can.material;
    document.getElementById('managementLabel').hidden = !(can.admin || can.treasury || can.material);
}

// Blocks a page the current role should not open
function canOpenPage(page) {
    const p = String(page || '').replace(/^\//, '').replace(/^pages\//, '');
    const can = roleCan(currentRole);
    if (p.startsWith('feedback_guest')) return can.material;
    if (p.startsWith('admin_material')) return can.material;
    if (p.startsWith('reset_password')) return can.material;
    if (p.startsWith('admin/')) return can.admin;
    if (['treasury.html', 'transactions.html', 'report-analysis.html'].includes(p)) return can.treasury;
    return true;
}

async function loadUserProfile() {
    let profile;
    try {
        profile = await api('/api/profile');
    } catch (err) {
        console.error('Could not load your profile:', err);
        const failedNameEl = document.getElementById('sidebarFullName');
        if (failedNameEl && err.status !== 401) failedNameEl.textContent = "Can't reach server";
        return;
    }

    currentUserId = profile.id;
    localStorage.removeItem('kimangu_ai_chats_v1');
    applyRoleMenu(profile.account_type);

    const fullName = profile.full_name || 'Member';
    const phone = profile.phone && profile.phone !== 'N/A' ? profile.phone : '';
    const avatarUrl = profile.avatar_url || null;

    const firstName = fullName.trim().split(/\s+/)[0] || 'Member';
    const initials = getInitials(fullName);

    greetingName = firstName;
    renderGreeting();

    const sidebarNameEl = document.getElementById('sidebarFullName');
    if (sidebarNameEl) sidebarNameEl.textContent = firstName;

    updateAvatarUI(avatarUrl, initials);

    document.getElementById('apName').textContent = fullName;
    document.getElementById('apPhone').textContent = phone || 'Not added yet';

    fetchAndRenderNotifications(currentUserId);
}

// ===================== AVATAR PANEL =====================
function setApStatus(msg, type = '') {
    apStatus.textContent = msg;
    apStatus.className = 'ap-status ' + type;
}

function closeAvatarPanel() {
    avatarPanel.classList.remove('open');
    avatarBox.classList.remove('open');
}

function compressImage(file, max = 250, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(img.src);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

avatarBox.addEventListener('click', () => {
    const open = avatarPanel.classList.toggle('open');
    avatarBox.classList.toggle('open', open);
    if (open && notifDropdown) notifDropdown.classList.remove('active');
});

document.addEventListener('click', (e) => {
    if (!avatarWrap.contains(e.target)) closeAvatarPanel();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAvatarPanel();
});

apInput.addEventListener('change', async () => {
    const file = apInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        setApStatus('Choose an image file.', 'error');
        return;
    }
    try {
        pendingAvatar = await compressImage(file);
        paintAvatar(document.getElementById('apPreview'), pendingAvatar, '');
        apSave.disabled = false;
        setApStatus('');
    } catch (err) {
        setApStatus('Could not read that image.', 'error');
    }
});

apSave.addEventListener('click', async () => {
    if (!pendingAvatar || !currentUserId) return;
    apSave.disabled = true;
    setApStatus('Saving…');

    try {
        await api('/api/profile/update', { method: 'POST', body: { avatar_url: pendingAvatar } });
    } catch (err) {
        apSave.disabled = false;
        setApStatus(err.message || 'Not saved. Please try again.', 'error');
        return;
    }

    pendingAvatar = null;
    apInput.value = '';
    setApStatus('Photo saved.', 'success');
    loadUserProfile();
});

// Global message listener for iframe postMessages
window.addEventListener('message', (event) => {
    if (event.data === 'profileUpdated') {
        loadUserProfile();
    } else if (event.data && event.data.type === 'navigate') {
        navigateToSidebarPage(event.data.page);
    }
});

// ===================== PERSISTENT SHELL NAVIGATION =====================
function applyIframeBottomPadding() {
    try {
        const iframeDoc = contentFrame.contentDocument || contentFrame.contentWindow.document;
        if (iframeDoc && iframeDoc.head) {
            let styleTag = iframeDoc.getElementById('custom-iframe-padding');
            if (!styleTag) {
                styleTag = iframeDoc.createElement('style');
                styleTag.id = 'custom-iframe-padding';
                iframeDoc.head.appendChild(styleTag);
            }
            styleTag.textContent = `
                    html { height: auto !important; min-height: 100% !important; }
                    body {
                        min-height: 100% !important;
                        padding-bottom: max(150px, calc(90px + env(safe-area-inset-bottom))) !important;
                        box-sizing: border-box !important;
                        overflow-y: auto !important;
                        -webkit-overflow-scrolling: touch !important;
                    }`;
        }
    } catch (err) {
        console.warn('Iframe style injection notice:', err);
    }
}

contentFrame.addEventListener('load', applyIframeBottomPadding);

document.querySelectorAll('.sidebar-nav a.sidebar-link[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        if (!canOpenPage(link.getAttribute('data-page'))) return;
        contentFrame.src = link.getAttribute('data-page');

        document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');

        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
    });
});

// Admin submenu toggle
if (adminToggle && adminSubmenu) {
    adminToggle.addEventListener('click', () => {
        adminToggle.classList.toggle('open');
        adminSubmenu.classList.toggle('open');
    });
}

// Notification dropdown toggle
if (notifBtn && notifDropdown) {
    notifBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAvatarPanel();
        notifDropdown.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
        if (!notifDropdown.contains(e.target) && !notifBtn.contains(e.target)) {
            notifDropdown.classList.remove('active');
        }
    });

    // Bell arrow follows the dropdown's "active" state; opening it marks everything as seen
    let notifWasOpen = false;
    new MutationObserver(() => {
        const isOpen = notifDropdown.classList.contains('active');
        notifBtn.classList.toggle('open', isOpen);
        if (isOpen && !notifWasOpen) onNotificationsOpened();
        if (!isOpen && notifWasOpen) onNotificationsClosed();
        notifWasOpen = isOpen;
    }).observe(notifDropdown, { attributes: true, attributeFilter: ['class'] });
}

// Mobile sidebar toggle
if (sidebarToggle && sidebar && sidebarOverlay) {
    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.add('active');
        sidebarOverlay.classList.add('active');
    });
    sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
    });
}

// Navigation handler (updates iframe and moves the active highlight)
function navigateToSidebarPage(targetPage) {
    if (!canOpenPage(targetPage)) return;
    const frame = document.getElementById('contentFrame');
    if (!frame) return;

    frame.src = targetPage;

    document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.sidebar-dropdown').forEach(d => d.classList.remove('active'));

    // 'pages/schedules.html' -> 'schedules.html'
    const cleanTarget = targetPage.replace(/^pages\//, '').replace(/^\//, '');

    const matchingLink = Array.from(document.querySelectorAll('.sidebar-link')).find(link => {
        const pageAttr = link.getAttribute('data-page') || link.getAttribute('href') || '';
        if (!pageAttr) return false;
        return cleanTarget === pageAttr.replace(/^pages\//, '').replace(/^\//, '');
    });

    if (matchingLink) {
        matchingLink.classList.add('active');

        // Open the parent dropdown / submenu automatically
        const dropdownParent = matchingLink.closest('.sidebar-dropdown');
        if (dropdownParent) dropdownParent.classList.add('active');

        const parentSubmenu = matchingLink.closest('.admin-submenu');
        if (parentSubmenu) {
            parentSubmenu.classList.add('open');
            if (adminToggle) adminToggle.classList.add('open');
        }
    }
}

// Logout
const logoutLink = document.getElementById('logoutLink');
if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const token = getToken();
        if (token) {
            try {
                await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            } catch (err) { /* sign out locally anyway */ }
        }
        clearSession();
        window.location.href = 'index.html';
    });
}

// ===================== START =====================
renderGreeting();
setInterval(renderGreeting, 60 * 1000); // pick up period changes (e.g. morning -> noon)
setInterval(renderNotifications, 60 * 1000); // drops notifications 6 hours after they were seen
loadUserProfile().then(initLocation);