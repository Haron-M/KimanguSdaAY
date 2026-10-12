/*
 * api.js - shared helper for every page.
 * Pages talk to your Node server through api(); they never talk to the database directly.
 * Put this file in the site root (next to dashboard.html) and load it with
 *   <script src="../api.js"></script>      (pages inside /pages/)
 *   <script src="../../api.js"></script>   (pages inside /pages/admin/)
 */
(function () {
    // Local development: server on port 5000. In production set API_BASE to your server's address
    // (use '' if the server also serves the site).
    const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? 'http://localhost:5000'
        : '';

    // auth.html sits next to this file, whatever folder the page is in
    const scriptUrl = document.currentScript ? document.currentScript.src : window.location.href;
    const LOGIN_URL = new URL('auth.html', scriptUrl).href;

    const TOKEN_KEYS = ['token', 'access_token', 'authToken', 'kimangu_token'];
    const REFRESH_KEY = 'refresh_token';
    const LEGACY_KEY = /^sb-.+-auth-token$/;

    class ApiError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status;
        }
    }

    // Pages that still use the Supabase library keep a full session in an "sb-...-auth-token" entry.
    // It is the shared copy: every page reads it and updates it. Remove once no page uses that library.
    function readLegacySession() {
        for (const key of Object.keys(localStorage)) {
            if (!LEGACY_KEY.test(key)) continue;
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
        Object.keys(localStorage).filter(key => LEGACY_KEY.test(key)).forEach(key => localStorage.removeItem(key));
    }

    function goToLogin(reason) {
        console.warn(`Sending you to the login page: ${reason}.`);
        (window.top || window).location.href = LOGIN_URL; // pages run inside the dashboard frame
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

    // Calls your server with the saved token. On a 401 it refreshes the session once and retries;
    // if that fails the user is sent to the login page.
    async function api(path, { method = 'GET', body, retry = true } = {}) {
        const token = getToken();
        if (!token) {
            goToLogin('no saved login was found in this browser');
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
            // Another page may already have refreshed the token: just retry with the new one
            const latest = getToken();
            if (retry && latest && latest !== token) return api(path, { method, body, retry: false });

            if (retry && await refreshSession()) return api(path, { method, body, retry: false });

            clearSession();
            goToLogin(`the server answered 401 (not signed in) for ${path}`);
            throw new ApiError('Session expired', 401);
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
        return data;
    }

    window.api = api;
    window.ApiError = ApiError;
    window.API_BASE = API_BASE;
    window.getToken = getToken;
    window.clearSession = clearSession;
})();