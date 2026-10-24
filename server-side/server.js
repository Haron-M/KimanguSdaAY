require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ===================== MIDDLEWARE =====================

app.use(cors({
    origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
        : '*'
}));

app.use(express.json({ limit: '10mb' }));

app.use(express.static(path.join(__dirname, '../client')));

const CLIENT_OPTIONS = {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
};

// Service-role client: use only for trusted server-side database operations.
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    CLIENT_OPTIONS
);

function authClient() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        CLIENT_OPTIONS
    );
}

// ===================== ACCESS CODES =====================

const ACCESS_CODES = {
    '412367': 'admin',
    '432467': 'regular',
    '432566': 'treasury',
    '432664': 'superuser'
};

const INCOME_TYPES = ['deposit', 'income', 'revenue'];
const PAYMENT_NOTIF_MAX_AGE_DAYS = 7;
const PAYMENT_NOTIF_LIMIT = 20;

function phoneToEmail(phone) {
    const cleaned = String(phone).replace(/\D/g, '');
    return `${cleaned}@kimanguay.org`;
}

// ===================== AUTHENTICATION MIDDLEWARE =====================

async function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized: Access token missing'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const { data, error } = await supabase.auth.getUser(token);
        const user = data && data.user;

        if (error || !user) {
            console.warn(
                `Auth check failed for ${req.method} ${req.path}:`,
                error
                    ? `${error.name}: ${error.message}`
                    : 'no user returned'
            );

            const temporary = error && (
                error.name === 'AuthRetryableFetchError' ||
                error.status >= 500
            );

            if (temporary) {
                return res.status(503).json({
                    error: 'Authentication service unavailable. Please try again.'
                });
            }

            return res.status(401).json({
                error: 'Unauthorized: Invalid or expired token'
            });
        }

        req.user = user;
        req.token = token;

        return next();
    } catch (err) {
        console.error('[Authentication] Error:', err.message);

        return res.status(503).json({
            error: 'Authentication service unavailable. Please try again.'
        });
    }
}

// ===================== AUTHENTICATION ENDPOINTS =====================

// 1. Verify access code
app.post('/api/auth/verify-code', (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({
            error: 'Please provide a 6-digit access code.'
        });
    }

    const accountType = ACCESS_CODES[code];

    if (!accountType) {
        return res.status(400).json({
            error: 'Invalid access code. Please check with your AY leader.'
        });
    }

    res.json({ success: true, accountType });
});

// 2. User sign-up
app.post('/api/auth/signup', async (req, res) => {
    try {
        const {
            fullName,
            phone,
            password,
            category,
            accountType
        } = req.body;

        if (!phone || !password || !fullName) {
            return res.status(400).json({
                error: 'Missing required sign-up fields.'
            });
        }

        const email = phoneToEmail(phone);

        const { data: signUpData, error: signUpError } =
            await authClient().auth.signUp({
                email,
                password
            });

        if (signUpError) {
            return res.status(400).json({
                error: signUpError.message
            });
        }

        const userId = signUpData.user
            ? signUpData.user.id
            : null;

        if (userId) {
            console.log('account_type being inserted:', JSON.stringify(accountType));
            const { error: profileError } = await supabase
                .from('profiles')
                .insert({
                    id: userId,
                    full_name: fullName,
                    phone,
                    category,
                    account_type: accountType
                });

            if (profileError) {
                return res.status(500).json({
                    error: 'Profile creation failed: ' + profileError.message
                });
            }
        }

        res.json({
            success: true,
            message: 'Account created successfully'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. User login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({
                error: 'Please enter your phone number and password.'
            });
        }

        const email = phoneToEmail(phone);

        const { data, error } =
            await authClient().auth.signInWithPassword({
                email,
                password
            });

        if (error || !data.session) {
            return res.status(400).json({
                error: 'Invalid phone number or password.'
            });
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

// 3b. Refresh expired access token
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                error: 'Refresh token missing.'
            });
        }

        const { data, error } =
            await authClient().auth.refreshSession({
                refresh_token: refreshToken
            });

        if (error || !data.session) {
            return res.status(401).json({
                error: 'Session expired. Please sign in again.'
            });
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
        // The token may already be expired or revoked.
    }

    res.json({ success: true });
});

// ===================== USER AND DASHBOARD ENDPOINTS =====================

// 4. Get logged-in user profile
app.get('/api/profile', authenticateUser, async (req, res) => {
    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('full_name, phone, category, avatar_url,account_type')
            .eq('id', req.user.id)
            .maybeSingle();

        if (error) throw error;

        res.json({
            id: req.user.id,
            email: req.user.email,
            full_name:
                profile?.full_name ||
                req.user.user_metadata?.full_name ||
                (req.user.email || '').split('@')[0],
            phone: profile?.phone || 'N/A',
            category: profile?.category || 'N/A',
            avatar_url: profile?.avatar_url || null,
            account_type: profile.account_type
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Update profile and avatar
app.post('/api/profile/update', authenticateUser, async (req, res) => {
    try {
        const {
            full_name,
            phone,
            category,
            avatar_url
        } = req.body;

        const updateData = {};

        if (full_name !== undefined) updateData.full_name = full_name;
        if (phone !== undefined) updateData.phone = phone;
        if (category !== undefined) updateData.category = category;

        if (avatar_url !== undefined) {
            const isImage =
                typeof avatar_url === 'string' &&
                avatar_url.startsWith('data:image/') &&
                avatar_url.length <= 300000;

            if (avatar_url !== null && !isImage) {
                return res.status(400).json({
                    error: 'Avatar must be a small image.'
                });
            }

            updateData.avatar_url = avatar_url;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                error: 'No profile fields were provided to update.'
            });
        }

        const { error } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', req.user.id);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5b. Get saved location
app.get('/api/profile/location', authenticateUser, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('last_ip, location_text, location_source')
            .eq('id', req.user.id)
            .maybeSingle();

        if (error) throw error;

        res.json(data || {
            last_ip: null,
            location_text: null,
            location_source: null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5c. Save location
app.put('/api/profile/location', authenticateUser, async (req, res) => {
    try {
        const { text, source, ip } = req.body;

        if (
            typeof text !== 'string' ||
            !text.trim() ||
            text.length > 120
        ) {
            return res.status(400).json({
                error: 'Invalid location text.'
            });
        }

        if (!['gps', 'ip'].includes(source)) {
            return res.status(400).json({
                error: 'Invalid location source.'
            });
        }

        const cleanIp =
            typeof ip === 'string' && ip.length <= 64
                ? ip
                : null;

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
            return res.status(404).json({
                error: 'Profile not found.'
            });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Dashboard financial and activity statistics
app.get('/api/dashboard/stats', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;

        const [
            { data: transactions, error: txError },
            { count: schedulesCount, error: schedError },
            { count: eventsCount, error: eventsError }
        ] = await Promise.all([
            supabase
                .from('transactions')
                .select('amount, type, user_id'),

            supabase
                .from('schedules')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId),

            supabase
                .from('events')
                .select('*', { count: 'exact', head: true })
        ]);

        if (txError) throw txError;

        const txList = transactions || [];

        const totalDeposits = txList
            .filter(tx =>
                String(tx.type).trim().toLowerCase() === 'deposit'
            )
            .reduce(
                (sum, tx) => sum + Number(tx.amount || 0),
                0
            );

        const totalExpenditures = txList
            .filter(tx =>
                String(tx.type).trim().toLowerCase() === 'expenditure'
            )
            .reduce(
                (sum, tx) => sum + Number(tx.amount || 0),
                0
            );

        const myTotalContribution = txList
            .filter(tx =>
                tx.user_id === userId &&
                String(tx.type).trim().toLowerCase() === 'deposit'
            )
            .reduce(
                (sum, tx) => sum + Number(tx.amount || 0),
                0
            );

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

// 7. Schedule notifications
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
        const since = new Date(
            Date.now() -
            PAYMENT_NOTIF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
        ).toISOString();

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

// 8. Announcements
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

// 9. Upcoming events
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

// ===================== ASK AI =====================
// Chat, history, greetings, date/time replies and the AI connectivity check
// (/api/ai/chat, /api/ai/history, /api/ai/ping) live in ask-ai.js.

require('./ask-ai')(app, { supabase, authenticateUser });

// ===================== SERVER STARTUP =====================

// Start a local server outside production. Vercel imports the Express app.
const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server active on http://localhost:${PORT}`);
    });
}

// Export Express app for Vercel serverless functions.
module.exports = app;