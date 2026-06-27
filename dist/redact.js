// Deterministic, model-independent secret-VALUE scrub.
//
// Ported from the Python eval harness (local_extract.py `redact_secrets` /
// `scrub_memory`, regression tests in test_redact_secrets.py). It anchors on
// strong credential keywords + a "secret-shaped value" gate, so it catches the
// obvious "<kw> is <value>" / "<kw> `<value>`" forms while leaving location
// pointers (~/.creds), usernames, and prose intact.
//
// This is belt-and-suspenders, NOT a guarantee: a value phrased with no keyword
// cue can still slip through (the prompt-level rule remains the first line of
// defense). We apply it specifically to IN-REPO memory writes, where a leaked
// credential could be committed/pushed — the global ~/.claude store is private
// to the user and is left untouched.
// Strong credential keywords. The WiFi/PSK family was added after a real leak
// (design-doc §18a): a session saved "PSK `<value>`" and the old keyword set had
// no psk/wpa/wifi term, so the quoted-value gate never even fired.
const SECRET_KW = "passwords?|passwd|pwd|passphrases?|api[\\s_-]?keys?|apikeys?|" +
    "access[\\s_-]?keys?|secret[\\s_-]?keys?|private[\\s_-]?keys?|" +
    "client[\\s_-]?secrets?|auth[\\s_-]?tokens?|bearer[\\s_-]?tokens?|" +
    "access[\\s_-]?tokens?|tokens?|secrets?|" +
    "psks?|pre[\\s_-]?shared[\\s_-]?keys?|wpa\\d?[\\s_-]?psks?|" +
    "wi[\\s_-]?fi[\\s_-]?(?:passwords?|keys?|psks?)|network[\\s_-]?keys?|" +
    "wireless[\\s_-]?keys?|passcodes?";
// The copula is OPTIONAL: real leaks appeared both as "password is 'X'" and
// "user 'admin' and password 'X'" (no copula) for the same secret. value = the
// whole non-space token after the keyword. \b stops `passwordis` keyword bleed.
// Built fresh per call (the `g` flag is stateful) — see redactSecrets.
function secretRegex() {
    return new RegExp(`\\b(${SECRET_KW})\\b(\\s*(?:is|are|was|set to|=|:|->)?\\s*)(['"\`]?)(\\S{3,})`, "gi");
}
const REDACT = "«REDACTED»";
const TRAIL = ".,;:!?)]}'\"`";
const COPULA = /(?:is|are|was|set to|=|:|->)/;
function rstripTrail(s) {
    let end = s.length;
    while (end > 0 && TRAIL.includes(s[end - 1]))
        end--;
    return s.slice(0, end);
}
// A credential value almost always carries a digit, mid-token uppercase, or a
// symbol. NOT length alone (that flagged ordinary long words like "requirements"),
// and NOT '/' or path/var prefixes (those are file paths / "password-protected").
function looksSecret(v) {
    if (!v || v.includes("/") || "~$.".includes(v[0]))
        return false;
    return /\d/.test(v) || /[A-Z]/.test(v.slice(1)) || /[._+=@!#%^&*]/.test(v);
}
// Scrub credential VALUES that follow a strong secret keyword. Returns the
// scrubbed text and the number of redactions performed.
export function redactSecrets(text) {
    if (!text)
        return { text, count: 0 };
    let count = 0;
    const out = text.replace(secretRegex(), (whole, kw, cop, quote, raw) => {
        const core = rstripTrail(raw);
        const trail = raw.slice(core.length);
        // a quoted value right after a cred keyword is itself a strong signal;
        // otherwise require a copula + secret-shape OR a digit-bearing bare token.
        const isQuoted = Boolean(quote);
        const hasCopula = COPULA.test(cop);
        const hit = isQuoted || (hasCopula ? looksSecret(core) : /\d/.test(core));
        if (core && hit) {
            count++;
            return `${kw}${cop}${quote}${REDACT}${trail}`;
        }
        return whole;
    });
    return { text: out, count };
}
// Apply redactSecrets to a memory's free-text fields; returns scrubbed fields and
// the total redaction count across them.
export function scrubMemoryFields(fields) {
    const n = redactSecrets(fields.name);
    const d = redactSecrets(fields.description);
    const c = redactSecrets(fields.content);
    return { name: n.text, description: d.text, content: c.text, count: n.count + d.count + c.count };
}
