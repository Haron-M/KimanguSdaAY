const fs = require('fs');
const path = require('path');

const CLIENT_DIR = path.join(__dirname, '../client');
const OUT_FILE = path.join(__dirname, '../server-side/knowledge/site-content.txt');
const SKIP = /(admin|auth|login|signup|treasury|transactions)/i;

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
        return entry.name.endsWith('.html') ? [full] : [];
    });
}

function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

const sections = [];
for (const file of walk(CLIENT_DIR)) {
    const rel = path.relative(CLIENT_DIR, file).replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    const text = htmlToText(fs.readFileSync(file, 'utf8'));
    if (text.length < 40) continue;
    sections.push(`## Page: ${rel}\n${text}`);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, sections.join('\n\n'), 'utf8');
console.log(`Wrote ${sections.length} pages to ${OUT_FILE}`);