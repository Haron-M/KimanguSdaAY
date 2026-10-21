require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const fs = require('fs');

const app = express();

// ===================== AI SETTINGS =====================
// Tip: a smaller NVIDIA model (set AI_MODEL in .env / Vercel) is the biggest speed boost.
const AI_MODEL = process.env.AI_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
const AI_HISTORY_LIMIT = 8;       // fewer past messages = smaller prompt = faster
const AI_MAX_TOKENS = 1400;       // room to FINISH the answer (the prompt asks for short answers anyway)
const AI_DEBUG = process.env.AI_DEBUG === 'true';
const PLATFORM_CACHE_MS = 60 * 1000;

// Ellen G. White page.paragraph numbers must be exact, and an AI model cannot reliably recall them.
// false (default): exact page.paragraph is used only when it comes from knowledge/egw-references.md;
//                  otherwise the answer cites the book only, with no number.
// true:            when the list has no match, the AI gives page.paragraph from its own memory
//                  (every answer carries a number, but some numbers will be wrong).
const EGW_ALLOW_UNVERIFIED_PAGES = process.env.EGW_ALLOW_UNVERIFIED_PAGES === 'true';

// ===================== KNOWLEDGE (loaded once, sent only when relevant) =====================
function readKnowledge(file, maxChars) {
    try {
        return fs.readFileSync(path.join(__dirname, 'knowledge', file), 'utf8').slice(0, maxChars);
    } catch (err) {
        console.warn(`Knowledge file missing: ${file}`);
        return '';
    }
}

// Split text into small sections (by headings, then by size) so we can send only what matches the question
function toSections(text, headingRegex, maxSize = 2500) {
    const parts = text.split(headingRegex).filter(p => p && p.trim());
    const out = [];
    for (const part of parts) {
        if (part.length <= maxSize) { out.push(part); continue; }
        for (let i = 0; i < part.length; i += 2000) out.push(part.slice(i, i + 2000));
    }
    return out;
}

const BELIEFS_TEXT = readKnowledge('adventist-beliefs.md', 40000);
const SITE_TEXT = readKnowledge('site-content.txt', 40000);
const BELIEF_SECTIONS = toSections(BELIEFS_TEXT, /\n(?=#{1,4}\s)/);
const SITE_SECTIONS = toSections(SITE_TEXT, /\n(?=## Page:)/);

// Verified Ellen G. White references, one per line:  Book Title | PAGE.PARAGRAPH | keywords | what it teaches
// Lines starting with # are comments. The file is optional (see EGW_ALLOW_UNVERIFIED_PAGES above).
const EGW_TEXT = readKnowledge('egw-references.md', 60000);
const EGW_SECTIONS = EGW_TEXT.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const STOP_WORDS = new Set([
    'what', 'which', 'when', 'where', 'that', 'this', 'with', 'from', 'have', 'does', 'about',
    'explain', 'tell', 'please', 'mean', 'your', 'there', 'their', 'would', 'could', 'should',
    'verse', 'bible', 'continue', 'more', 'give', 'show', 'make', 'know', 'like'
]);

function keywords(text) {
    const words = String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [];
    return [...new Set(words.filter(w => !STOP_WORDS.has(w)))];
}

function pickRelevant(sections, words, limit, maxChars) {
    if (!words.length || !sections.length) return '';
    return sections
        .map(s => {
            const lower = s.toLowerCase();
            return { s, score: words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0) };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.s.slice(0, maxChars))
        .join('\n\n');
}

// ===================== AI CLIENT =====================
// Created on first use, so a missing key only breaks the chat, never the whole server
let nvidiaClient = null;
function getNvidia() {
    if (!process.env.NVIDIA_API_KEY) {
        throw new Error('NVIDIA_API_KEY is not set on the server');
    }
    if (!nvidiaClient) {
        nvidiaClient = new OpenAI({
            baseURL: 'https://integrate.api.nvidia.com/v1',
            apiKey: process.env.NVIDIA_API_KEY,
            maxRetries: 1,
            timeout: 55 * 1000
        });
    }
    return nvidiaClient;
}

// Middleware
// Set CORS_ORIGIN in .env (comma separated, e.g. https://yoursite.com) to lock this down in production.
app.use(cors({
    origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : '*'
}));
app.use(express.json({ limit: '10mb' })); // Support Base64 image payloads up to 10MB

// ===================== SERVE STATIC FRONTEND =====================
// Serves all static HTML, CSS, and JS files from the client folder
app.use(express.static(path.join(__dirname, '../client')));

const CLIENT_OPTIONS = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
};

// Admin client (service role): used ONLY for database reads/writes and token checks.
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    CLIENT_OPTIONS
);

// A fresh client for every sign-up / sign-in / refresh
function authClient() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
        CLIENT_OPTIONS
    );
}

// Access Codes Dictionary
const ACCESS_CODES = {
    '412367': 'admin',
    '432467': 'regular'
};

const INCOME_TYPES = ['deposit', 'income', 'revenue'];
const PAYMENT_NOTIF_MAX_AGE_DAYS = 7;   // only payments from the last 7 days become notifications
const PAYMENT_NOTIF_LIMIT = 20;

// Helper: Convert phone number to internal domain email
function phoneToEmail(phone) {
    const cleaned = String(phone).replace(/\D/g, '');
    return `${cleaned}@kimanguay.org`;
}

// Middleware to verify Auth Tokens sent from client
async function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Access token missing' });
    }

    const token = authHeader.split(' ')[1];
    const { data, error } = await supabase.auth.getUser(token);
    const user = data && data.user;

    if (error || !user) {
        console.warn(`Auth check failed for ${req.method} ${req.path}:`, error ? `${error.name}: ${error.message}` : 'no user returned');

        const temporary = error && (error.name === 'AuthRetryableFetchError' || error.status >= 500);
        if (temporary) {
            return res.status(503).json({ error: 'Authentication service unavailable. Please try again.' });
        }
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }

    req.user = user;
    req.token = token;
    next();
}

// ===================== AUTHENTICATION ENDPOINTS =====================

// 1. Verify Access Code
app.post('/api/auth/verify-code', (req, res) => {
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ error: 'Please provide a 6-digit access code.' });
    }

    const accountType = ACCESS_CODES[code];
    if (!accountType) {
        return res.status(400).json({ error: 'Invalid access code. Please check with your AY leader.' });
    }

    res.json({ success: true, accountType });
});

// 2. User Sign Up
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { fullName, phone, password, category, accountType } = req.body;

        if (!phone || !password || !fullName) {
            return res.status(400).json({ error: 'Missing required sign-up fields.' });
        }

        const email = phoneToEmail(phone);

        const { data: signUpData, error: signUpError } = await authClient().auth.signUp({
            email,
            password
        });

        if (signUpError) {
            return res.status(400).json({ error: signUpError.message });
        }

        const userId = signUpData.user ? signUpData.user.id : null;

        if (userId) {
            const { error: profileError } = await supabase.from('profiles').insert({
                id: userId,
                full_name: fullName,
                phone: phone,
                category: category,
                account_type: accountType
            });

            if (profileError) {
                return res.status(500).json({ error: 'Profile creation failed: ' + profileError.message });
            }
        }

        res.json({ success: true, message: 'Account created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. User Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({ error: 'Please enter your phone number and password.' });
        }

        const email = phoneToEmail(phone);

        const { data, error } = await authClient().auth.signInWithPassword({
            email,
            password
        });

        if (error || !data.session) {
            return res.status(400).json({ error: 'Invalid phone number or password.' });
        }

        res.json({
            success: true,
            token: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresAt: data.session.expires_at,
            user: data.user
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3b. Refresh an expired access token
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token missing.' });
        }

        const { data, error } = await authClient().auth.refreshSession({ refresh_token: refreshToken });

        if (error || !data.session) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }

        res.json({
            success: true,
            token: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresAt: data.session.expires_at
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3c. Log out
app.post('/api/auth/logout', authenticateUser, async (req, res) => {
    try {
        await supabase.auth.admin.signOut(req.token);
    } catch (err) {
        // Token may already be expired or revoked
    }
    res.json({ success: true });
});

// ===================== USER & DASHBOARD ENDPOINTS =====================

// 4. Get Logged-in User Profile
app.get('/api/profile', authenticateUser, async (req, res) => {
    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('full_name, phone, category, avatar_url')
            .eq('id', req.user.id)
            .maybeSingle();

        if (error) throw error;

        res.json({
            id: req.user.id,
            email: req.user.email,
            full_name: profile?.full_name || req.user.user_metadata?.full_name || req.user.email.split('@')[0],
            phone: profile?.phone || 'N/A',
            category: profile?.category || 'N/A',
            avatar_url: profile?.avatar_url || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Update Profile & Avatar Image
app.post('/api/profile/update', authenticateUser, async (req, res) => {
    try {
        const { full_name, phone, category, avatar_url } = req.body;

        const updateData = {};
        if (full_name !== undefined) updateData.full_name = full_name;
        if (phone !== undefined) updateData.phone = phone;
        if (category !== undefined) updateData.category = category;

        if (avatar_url !== undefined) {
            const isImage = typeof avatar_url === 'string' && avatar_url.startsWith('data:image/') && avatar_url.length <= 300000;
            if (avatar_url !== null && !isImage) {
                return res.status(400).json({ error: 'Avatar must be a small image.' });
            }
            updateData.avatar_url = avatar_url;
        }

        const { error } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', req.user.id);

        if (error) throw error;

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5b. Saved location
app.get('/api/profile/location', authenticateUser, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('last_ip, location_text, location_source')
            .eq('id', req.user.id)
            .maybeSingle();

        if (error) throw error;

        res.json(data || { last_ip: null, location_text: null, location_source: null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/profile/location', authenticateUser, async (req, res) => {
    try {
        const { text, source, ip } = req.body;

        if (typeof text !== 'string' || !text.trim() || text.length > 120) {
            return res.status(400).json({ error: 'Invalid location text.' });
        }
        if (!['gps', 'ip'].includes(source)) {
            return res.status(400).json({ error: 'Invalid location source.' });
        }

        const cleanIp = typeof ip === 'string' && ip.length <= 64 ? ip : null;

        const { data, error } = await supabase
            .from('profiles')
            .update({
                location_text: text.trim(),
                location_source: source,
                last_ip: cleanIp,
                location_updated_at: new Date().toISOString()
            })
            .eq('id', req.user.id)
            .select('id');

        if (error) throw error;
        if (!data || !data.length) {
            return res.status(404).json({ error: 'Profile not found.' });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Get Dashboard Financial & Activity Stats
app.get('/api/dashboard/stats', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;

        const [
            { data: transactions, error: txError },
            { count: schedulesCount, error: schedError },
            { count: eventsCount, error: eventsError }
        ] = await Promise.all([
            supabase.from('transactions').select('amount, type, user_id'),
            supabase.from('schedules').select('*', { count: 'exact', head: true }).eq('user_id', userId),
            supabase.from('events').select('*', { count: 'exact', head: true })
        ]);

        if (txError) throw txError;

        const txList = transactions || [];

        const totalDeposits = txList
            .filter(tx => String(tx.type).trim().toLowerCase() === 'deposit')
            .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);

        const totalExpenditures = txList
            .filter(tx => String(tx.type).trim().toLowerCase() === 'expenditure')
            .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);

        const myTotalContribution = txList
            .filter(tx => tx.user_id === userId && String(tx.type).trim().toLowerCase() === 'deposit')
            .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);

        res.json({
            netBalance: totalDeposits - totalExpenditures,
            myContribution: myTotalContribution,
            schedulesCount: schedError ? 0 : (schedulesCount || 0),
            eventsCount: eventsError ? 0 : (eventsCount || 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Get Schedule Notifications
app.get('/api/notifications', authenticateUser, async (req, res) => {
    try {
        const { data: schedules, error } = await supabase
            .from('schedules')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        res.json(schedules || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7b. Recent payments received
app.get('/api/payments/recent', authenticateUser, async (req, res) => {
    try {
        const since = new Date(Date.now() - PAYMENT_NOTIF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', req.user.id)
            .in('type', INCOME_TYPES)
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(PAYMENT_NOTIF_LIMIT);

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. Get Announcements
app.get('/api/announcements', authenticateUser, async (req, res) => {
    try {
        const { data: items, error } = await supabase
            .from('announcements')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        res.json(items || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. Get Upcoming Events
app.get('/api/events', authenticateUser, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { data: events, error } = await supabase
            .from('events')
            .select('*')
            .gte('event_date', today)
            .order('event_date', { ascending: true })
            .limit(20);

        if (error) throw error;
        res.json(events || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===================== INSTANT GREETING REPLIES =====================
// A message that is ONLY a greeting ("hi", "habari", "good morning, how are you?") gets a
// ready-made answer: no database reads and no AI call, so it appears immediately.
// A message that also contains a question ("hello, what is the Sabbath?") is NOT treated
// as a greeting and goes to the AI as normal.
//
// To support more greetings, add words to GREETING_PHRASES below (regex text, lowercase).
const GREETING_PHRASES = [
    // Order matters: longer / more specific phrases first, plain greetings last.
    { re: 'u hali gani|hali yako|uko vipi|uko aje', lang: 'sw', kind: 'howareyou' },
    { re: 'how (?:are|r) (?:you|u)(?: doing today| doing| today| now)?|how is it going|hows it going|how do you do|hows you|whats up|wassup|what up', kind: 'howareyou' },
    { re: 'happy sabbath|blessed sabbath|good sabbath|sabbath greetings|sabbath blessings', kind: 'sabbath' },
    { re: 'sabato njema', lang: 'sw', kind: 'sabbath' },
    { re: 'praise the lord|praise god|praise jesus|hallelujah', kind: 'praise' },
    { re: 'bwana asifiwe', lang: 'sw', kind: 'praise' },
    { re: 'habari(?: yako| yenu| gani| za (?:asubuhi|mchana|jioni|leo|siku|usiku))?|hujambo|hamjambo|salamu|shikamoo|marahaba|niaje|mambo(?: vipi)?|vipi|sasa', lang: 'sw' },
    { re: 'good (?:morning|afternoon|evening|day)|morning|afternoon|evening|hi+|hel+o+|hey+|hallo|hola|howdy|greetings|yo|sup|shalom|peace|god bless(?: you)?' }
];

const GREETING_PATTERNS = GREETING_PHRASES.map(p => ({
    ...p,
    rx: new RegExp(`\\b(?:${p.re})\\b`, 'g')
}));

// Harmless words that may follow a greeting ("hello there", "hi Ask AI", "good morning everyone")
const GREETING_FILLERS = /\b(?:there|ai|ask|assistant|bot|friend|friends|everyone|all|team|dear|my|sir|madam|brother|sister|pastor|please|today|and)\b/g;

const GREETING_REPLIES = {
    en: {
        general: [
            "Hello! I'm Ask AI, your Bible and Adventist faith assistant. What would you like to learn about today?",
            "Hi there! Welcome to Ask AI. Ask me anything about the Bible, Adventist beliefs, or how to use this platform.",
            "Greetings! I'm here to help with your questions on the Bible, prayer, and Seventh-day Adventist faith. What is on your mind?"
        ],
        howareyou: [
            "I'm doing well, thank you for asking! How can I help you with the Bible or Adventist faith today?"
        ],
        sabbath: [
            "Happy Sabbath! May God bless your day. What would you like to explore from the Bible or Adventist faith?"
        ],
        praise: [
            "Amen, praise the Lord! How can I help you with the Bible or Adventist faith today?"
        ]
    },
    sw: {
        general: [
            "Habari! Mimi ni Ask AI, msaidizi wako wa Biblia na imani ya Waadventista. Ungependa kujifunza nini leo?",
            "Karibu! Niulize swali lolote kuhusu Biblia, imani ya Waadventista, au jinsi ya kutumia jukwaa hili.",
            "Hujambo! Niko hapa kukusaidia na maswali yako kuhusu Biblia, maombi na imani ya Waadventista Wasabato. Una swali gani?"
        ],
        howareyou: [
            "Niko vizuri, asante kwa kuuliza! Nikusaidie vipi leo kuhusu Biblia au imani ya Waadventista?"
        ],
        sabbath: [
            "Sabato njema! Mungu akubariki siku yako. Ungependa kujifunza nini kutoka Biblia au imani ya Waadventista?"
        ],
        praise: [
            "Amina, Bwana asifiwe! Nikusaidie vipi leo kuhusu Biblia au imani ya Waadventista?"
        ]
    }
};

// Returns a predefined reply if the whole message is a greeting, otherwise null
function getGreetingReply(message) {
    let text = String(message || '')
        .toLowerCase()
        .replace(/['’`]/g, '')        // "what's" -> "whats"
        .replace(/[^a-z\s]/g, ' ')    // drop punctuation, digits and emojis
        .replace(/\s+/g, ' ')
        .trim();

    if (!text || text.length > 60) return null;

    let swahili = false;
    const kinds = new Set();

    for (const p of GREETING_PATTERNS) {
        text = text.replace(p.rx, () => {
            kinds.add(p.kind || 'general');
            if (p.lang === 'sw') swahili = true;
            return ' ';
        });
    }

    if (!kinds.size) return null;                              // no greeting words at all
    if (text.replace(GREETING_FILLERS, ' ').trim()) return null; // something else was said too

    const kind = ['sabbath', 'praise', 'howareyou', 'general'].find(k => kinds.has(k));
    const options = GREETING_REPLIES[swahili ? 'sw' : 'en'][kind];
    return options[Math.floor(Math.random() * options.length)];
}

// ===================== AI ASSISTANT =====================

// Events, announcements and books are the same for everyone, so cache them for a minute
let platformCache = { at: 0, data: null };
async function getPlatformData() {
    if (platformCache.data && Date.now() - platformCache.at < PLATFORM_CACHE_MS) {
        return platformCache.data;
    }
    const today = new Date().toISOString().split('T')[0];
    const [{ data: events }, { data: news }, { data: books }] = await Promise.all([
        supabase.from('events').select('*').gte('event_date', today).order('event_date', { ascending: true }).limit(8),
        supabase.from('announcements').select('*').order('created_at', { ascending: false }).limit(8),
        supabase.from('study_books').select('*').limit(60)
    ]);
    platformCache = { at: Date.now(), data: { events: events || [], news: news || [], books: books || [] } };
    return platformCache.data;
}

function buildSystemPrompt(profile, platform, topicText) {
    const words = keywords(topicText);

    const eventLines = platform.events.map(e =>
        `- ${e.title || e.name || 'Event'} on ${e.event_date}${e.location ? ' at ' + e.location : ''}`).join('\n') || 'None listed.';
    const newsLines = platform.news.map(a =>
        `- ${a.title || a.message || a.content || 'Announcement'}`).join('\n') || 'None.';
    const bookLines = platform.books.map(b =>
        `- ${b.title || b.name || 'Book'}${b.author ? ' by ' + b.author : ''}`).join('\n') || 'None listed.';

    // Only the parts of the knowledge base that match the question (keeps the prompt small = faster)
    const beliefs = pickRelevant(BELIEF_SECTIONS, words, 4, 2200) || BELIEFS_TEXT.slice(0, 2000) || 'Not available.';
    const sitePages = pickRelevant(SITE_SECTIONS, words, 2, 1800) || 'Not needed for this question.';
    const egwRefs = pickRelevant(EGW_SECTIONS, words, 3, 400) || 'No verified reference matches this question.';

    const egwFallbackRule = EGW_ALLOW_UNVERIFIED_PAGES
        ? '- If no verified reference fits, use the Ellen G. White book that covers this topic and the page and paragraph you remember best.'
        : '- If no verified reference fits, name one Ellen G. White book that covers this topic and write it WITHOUT any number, like ([[Desire of Ages]]). NEVER write a page or paragraph number that is not in the verified list.';

    return `You are "Ask AI", the Bible and Adventist-faith assistant of the Kimangu AY (Seventh-day Adventist Youth) platform,you are developed by Haron Moenga who is a software developer.

SCOPE
- Answer ONLY religious questions: the Bible, Christian living, prayer, church life, and above all Seventh-day Adventist beliefs, history, lifestyle, Sabbath School, Adventist Youth and the Spirit of Prophecy.
- You may also explain how to use this platform (its pages, events, announcements, resources, books), since that is part of church life here.
- For anything else (politics, maths, coding, entertainment, general trivia, medical or legal advice), decline in one short sentence and invite a faith question. Do not answer any part of it.

PRECISION
- Answer exactly what was asked. The first sentence must be the direct answer. No preamble, no repeating the question, no unrequested extras.
- Keep answers under about 260 words. Go longer only if the member asks for detail or a study, and even then stay under 380 words. ALWAYS finish your last sentence, including the required Ellen G. White line; if the topic is big, cover the main points and offer to continue.
- For Adventist teaching, base the answer on the Fundamental Beliefs below and name the belief number.
- If asked about another denomination or religion, describe it respectfully and accurately, then give the Adventist position.
- Reply in the language the member writes in (English or Swahili). The Bible verse is quoted in the language of the answer when you know that translation well; otherwise quote it in English.

SOURCES (required for every spiritual answer)
- A spiritual answer is any answer about the Bible, doctrine, Christian living, prayer, church history or Adventist belief. Questions about the platform itself (events, announcements, payments, how to use a page) and polite declines are NOT spiritual answers and need neither a verse nor an Ellen G. White line.
- Every spiritual answer MUST contain BOTH of these:
1. A Bible verse quoted word for word (King James Version unless the member asks for another version), one to three verses at most, followed by its reference, like: "For God so loved the world, that he gave his only begotten Son..." [[John 3:16]]
2. An Ellen G. White reference on its own final line. The line starts with "Ellen G. White:", then one sentence saying what she teaches on this point, then the citation in exactly this format: ([[Desire of Ages p 234.3]]) which means book title, then p, then the page number, a dot, and the paragraph number. Write the book title in full, without "The" and never abbreviated. The numbers in this example only show the shape of the citation; never reuse them unless the verified list gives exactly those numbers.
- Put quotation marks only around Bible words. Summarize Ellen G. White in your own words and never put words in quotation marks as hers.
- For the Ellen G. White citation, use a reference from the VERIFIED ELLEN G. WHITE REFERENCES below whenever one fits the question, copying its book, page and paragraph exactly.
${egwFallbackRule}

OUTPUT FORMAT (very important, the app does the styling)
- Plain text only. NEVER use asterisks, hash symbols, backticks, tables, vertical bars, horizontal lines, or HTML tags.
- Heading: put "## " at the start of its own line. Use headings only when the answer has several parts; short answers need none.
- Numbered points: start the line with "1. ", "2. ", "3. " and so on. Unordered points: start the line with "- ".
- Wrap EVERY Bible reference in double square brackets, like [[John 3:16]] or [[Hebrews 7:1-4]]. Wrap every Ellen G. White citation the same way, inside round brackets, like ([[Desire of Ages p 234.3]]) or ([[Steps to Christ]]).
- Never write a Bible reference or an Ellen G. White citation outside double square brackets.
- To compare things, use numbered points or short paragraphs, never a table.
- Put a blank line between sections. Keep each point to one or two sentences.

HONESTY
- If something is not in the knowledge below or you are unsure, say so. Never invent verses, quotes, dates or church details.
- For local details (service times, leaders, programs), use only the platform information below; otherwise tell the member to ask the AY leaders.
- Never ask for passwords. Never share other members' details.

MEMBER: ${profile?.full_name || 'Member'} (category: ${profile?.category || 'N/A'})

UPCOMING EVENTS
${eventLines}

LATEST ANNOUNCEMENTS
${newsLines}

BOOKS AVAILABLE ON THE PLATFORM
${bookLines}

PLATFORM PAGES: Home, Media Center, Resources, My Schedules, Accounts, Treasury Desk (Payment, Transaction History, Report Analysis).

PLATFORM CONTENT (relevant parts)
${sitePages}

ADVENTIST KNOWLEDGE (relevant parts)
${beliefs}

VERIFIED ELLEN G. WHITE REFERENCES (format: Book | page.paragraph | topics | what it teaches)
${egwRefs}`;
}

// Saved conversation for the logged-in member
app.get('/api/ai/history', authenticateUser, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('ai_chat_messages')
            .select('role, content, created_at')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(30);
        if (error) throw error;
        res.json((data || []).reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear the conversation
app.delete('/api/ai/history', authenticateUser, async (req, res) => {
    try {
        const { error } = await supabase.from('ai_chat_messages').delete().eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send a message. Greetings get an instant predefined reply; everything else is streamed
// from the AI token by token. Both messages are saved afterwards.
app.post('/api/ai/chat', authenticateUser, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 2000) {
        return res.status(400).json({ error: 'Message must be 1 to 2000 characters.' });
    }

    const t0 = Date.now();

    // ---------- FAST PATH: greeting -> predefined reply, no database reads, no AI call ----------
    const instantReply = getGreetingReply(message);
    if (instantReply) {
        try {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('X-Ask-AI-Source', 'instant');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            // The member sees the reply right now...
            res.write(instantReply);

            // ...and the conversation is saved before the response is closed
            // (serverless hosts like Vercel can stop work after the response ends)
            const { error: saveError } = await supabase.from('ai_chat_messages').insert([
                { user_id: req.user.id, role: 'user', content: message },
                { user_id: req.user.id, role: 'assistant', content: instantReply }
            ]);
            if (saveError) console.warn('Could not save greeting messages:', saveError.message);
        } catch (err) {
            console.warn('Instant greeting error:', err.message);
        } finally {
            if (!res.writableEnded) res.end();
        }
        console.log('[Ask AI] Instant greeting sent after', Date.now() - t0, 'ms');
        return;
    }

    // ---------- NORMAL PATH: real question -> stream the AI answer as it is generated ----------
    let stream = null;

    try {
        const userId = req.user.id;

        // All database work runs at the same time
        const [{ data: past }, { data: profile }, platform] = await Promise.all([
            supabase.from('ai_chat_messages').select('role, content').eq('user_id', userId)
                .order('created_at', { ascending: false }).limit(AI_HISTORY_LIMIT),
            supabase.from('profiles').select('full_name, category').eq('id', userId).maybeSingle(),
            getPlatformData()
        ]);
        console.log('1 database ms:', Date.now() - t0);

        const history = (past || []).reverse();

        // For short follow-ups ("continue", "explain more") also use the previous question to find the topic
        const lastUser = [...history].reverse().find(m => m.role === 'user');
        const topicText = message + ' ' + (message.length < 40 && lastUser ? lastUser.content : '');

        const messages = [
            { role: 'system', content: buildSystemPrompt(profile, platform, topicText) },
            ...history,
            { role: 'user', content: message }
        ];

        stream = await getNvidia().chat.completions.create({
            model: AI_MODEL,
            messages,
            temperature: 0.3,
            top_p: 0.9,
            max_tokens: AI_MAX_TOKENS,
            chat_template_kwargs: { enable_thinking: false },
            stream: true
        });
        console.log('2 NVIDIA accepted ms:', Date.now() - t0);

        // Stop paying for / waiting on the AI if the member closes the chat mid-answer
        res.on('close', () => {
            if (!res.writableEnded && stream && stream.controller) stream.controller.abort();
        });

        // The AI accepted the request, so start streaming the reply immediately.
        // no-transform + X-Accel-Buffering stop proxies from holding the text back.
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Ask-AI-Source', 'ai');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        let reply = '';
        let finishReason = null;
        let firstTokenLogged = false;

        // Every piece of text is written to the browser the moment the AI produces it
        for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;

            if (delta) {
                if (!firstTokenLogged) {
                    firstTokenLogged = true;
                    console.log(
                        '[Ask AI] First token after request:',
                        Date.now() - t0,
                        'ms'
                    );
                }

                reply += delta;
                res.write(delta);
            }

            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }
        }

        console.log('[Ask AI] Total generation time:', Date.now() - t0, 'ms');

        // If the model ran out of room, say so instead of silently stopping
        if (finishReason === 'length') {
            const note = '\n\n(This answer was long. Send "continue" to get the rest.)';
            reply += note;
            res.write(note);
        }
        res.end();

        // Save both messages only after a successful answer
        if (reply.trim()) {
            const { error: saveError } = await supabase.from('ai_chat_messages').insert([
                { user_id: userId, role: 'user', content: message },
                { user_id: userId, role: 'assistant', content: reply }
            ]);
            if (saveError) console.warn('Could not save AI chat messages:', saveError.message);
        }
    } catch (err) {
        // Member closed the chat: nothing to report
        if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) {
            if (!res.writableEnded) res.end();
            return;
        }

        console.error('AI chat error:', err.status || '', err.message, err.error ? JSON.stringify(err.error) : '');

        if (!res.headersSent && !res.writableEnded) {
            const friendly = 'The assistant is unavailable right now.';
            return res.status(500).json({
                error: AI_DEBUG ? `AI error ${err.status || ''}: ${err.message}` : friendly
            });
        }
        if (!res.writableEnded) {
            res.write('\n\n(Connection interrupted. Please try again.)');
            res.end();
        }
    }
});
app.get('/api/ai/ping', async (req, res) => {
    const t0 = Date.now();
    try {
        await getNvidia().chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 20
        });
        res.json({ ms: Date.now() - t0, model: AI_MODEL });
    } catch (e) {
        res.status(500).json({ error: e.message, ms: Date.now() - t0 });
    }
});
// Start Server Locally (Ignored on Vercel)
const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server active on http://localhost:${PORT}`);
    });
}

// Export Express app for Vercel Serverless Functions
module.exports = app;