require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const nvidia = new OpenAI({
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY
});
const AI_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const AI_HISTORY_LIMIT = 12;   // past messages sent to the AI for context

const app = express();

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
            eventsCount: eventsError ? 0 : (eventsError || 0)
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
// ===================== AI CHAT =====================
async function buildAiContext(userId) {
    const today = new Date().toISOString().split('T')[0];
    const [{ data: profile }, { data: events }, { data: news }] = await Promise.all([
        supabase.from('profiles').select('full_name, category').eq('id', userId).maybeSingle(),
        supabase.from('events').select('*').gte('event_date', today).order('event_date', { ascending: true }).limit(5),
        supabase.from('announcements').select('*').order('created_at', { ascending: false }).limit(5)
    ]);

    const eventLines = (events || []).map(e =>
        `- ${e.title || e.name || 'Event'} on ${e.event_date}${e.location ? ' at ' + e.location : ''}`).join('\n') || 'None listed.';
    const newsLines = (news || []).map(a =>
        `- ${a.title || a.message || a.content || 'Announcement'}`).join('\n') || 'None.';

    return `You are "Ask AI", the friendly assistant inside the Kimangu AY (Seventh-day Adventist Youth) members dashboard.
Member: ${profile?.full_name || 'Member'} (category: ${profile?.category || 'N/A'}).
The dashboard has: Home, Media Center, Resources, My Schedules, Accounts, and a Treasury Desk (Payment, Transaction History, Report Analysis).
Upcoming events:\n${eventLines}
Latest announcements:\n${newsLines}
Be warm, clear and concise. Answer Bible and church questions respectfully. If you don't know something specific to this church, say so instead of guessing. Never ask for passwords or share other members' details.`;
}

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

app.delete('/api/ai/history', authenticateUser, async (req, res) => {
    try {
        const { error } = await supabase.from('ai_chat_messages').delete().eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ai/chat', authenticateUser, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 2000) {
        return res.status(400).json({ error: 'Message must be 1 to 2000 characters.' });
    }

    try {
        const userId = req.user.id;

        const [{ data: past }, system] = await Promise.all([
            supabase.from('ai_chat_messages').select('role, content').eq('user_id', userId)
                .order('created_at', { ascending: false }).limit(AI_HISTORY_LIMIT),
            buildAiContext(userId)
        ]);

        await supabase.from('ai_chat_messages').insert({ user_id: userId, role: 'user', content: message });

        const messages = [
            { role: 'system', content: system },
            ...(past || []).reverse(),
            { role: 'user', content: message }
        ];

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        const stream = await nvidia.chat.completions.create({
            model: AI_MODEL,
            messages,
            temperature: 0.7,
            top_p: 0.95,
            max_tokens: 2048,
            // Set to true for deeper reasoning (slower). Reasoning text is never sent to the browser.
            extra_body: { chat_template_kwargs: { enable_thinking: false } },
            stream: true
        });

        let reply = '';
        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
                reply += delta;
                res.write(delta);
            }
        }
        res.end();

        if (reply.trim()) {
            await supabase.from('ai_chat_messages').insert({ user_id: userId, role: 'assistant', content: reply });
        }
    } catch (err) {
        console.error('AI chat error:', err.message);
        if (!res.headersSent) return res.status(500).json({ error: 'The assistant is unavailable right now.' });
        res.write('\n\n[Connection interrupted. Please try again.]');
        res.end();
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