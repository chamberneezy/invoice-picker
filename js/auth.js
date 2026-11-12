// Password gate. GitHub Pages is static, so this runs in the browser: it keeps the tool away from
// people who only have the link, and the repository holds just a slow PBKDF2 hash of the password.
// Nothing is remembered: every page load (and every back/forward restore) asks again.
import cfg from "./auth-hash.js";

const $ = (id) => document.getElementById(id);
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function check(password) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64(cfg.salt), iterations: cfg.iterations }, key, 256));
  const want = b64(cfg.hash);
  let diff = bits.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= bits[i] ^ want[i];
  return diff === 0;
}

export function lock() {
  $("app").hidden = true;
  $("gate").hidden = false;
  $("pw").value = "";
  $("pwMsg").hidden = true;
  $("pw").focus();
}

function unlock() {
  $("gate").hidden = true;
  $("app").hidden = false;
  $("pw").value = "";
  document.dispatchEvent(new Event("app:unlocked"));
}

let fails = 0;
$("gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("pw").value;
  if (!pw) return;
  const btn = $("pwGo");
  btn.disabled = true; btn.textContent = "Provjeravam…";
  $("pwMsg").hidden = true;
  try {
    const ok = window.crypto?.subtle ? await check(pw) : null;
    if (ok === null) { $("pwMsg").textContent = "Preglednik ne podržava provjeru lozinke. Otvorite stranicu preko https://."; $("pwMsg").hidden = false; return; }
    if (ok) { fails = 0; unlock(); return; }
    fails++;
    // slow down guessing a little more after each miss
    await new Promise((r) => setTimeout(r, Math.min(fails, 10) * 300));
    $("pwMsg").textContent = "Pogrešna lozinka.";
    $("pwMsg").hidden = false;
    $("pw").select();
  } finally {
    btn.disabled = false; btn.textContent = "Prijava";
  }
});

window.addEventListener("pageshow", (e) => { if (e.persisted) lock(); });
lock();
