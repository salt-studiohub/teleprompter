// Shared helpers for the mobile controller and the prompter screen (display).
export const firebaseConfig = {
  apiKey: "AIzaSyBUHx6sXriEyVscQZQ__LcHc-VbHtSsVH8",
  authDomain: "salt-teleprompter.firebaseapp.com",
  projectId: "salt-teleprompter",
  storageBucket: "salt-teleprompter.firebasestorage.app",
  messagingSenderId: "985970549218",
  appId: "1:985970549218:web:4d2160d631acf385ead9bb"
};
export const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.3/';
export const SESSION_TTL_MS = 12 * 3600 * 1000;      // a session expires 12h after its last write
export const MAX_TEXT = 900000;                       // Firestore documents are limited to ~1 MB

export const esc = (v)=>String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 0→A … 25→Z, 26→AA, 27→BB … 52→AAA …
export const labelFor = (i)=> String.fromCharCode(65 + (i % 26)).repeat(Math.floor(i / 26) + 1);

export function buildParagraphs(text, container){
  container.innerHTML = '';
  const labelMap = {};
  const paras = (text || '').replace(/\r\n/g, '\n').split(/\n\s*\n+/);
  let n = 0;
  for (let i = 0; i < paras.length; i++){
    const raw = paras[i];
    if (!raw.trim() && i !== 0) continue;
    const label = labelFor(n++);
    const para = document.createElement('div');
    para.className = 'para'; para.setAttribute('data-label', label); para.id = 'para-' + label;
    const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = label;
    const pt = document.createElement('div'); pt.className = 'ptext'; pt.textContent = raw;
    para.appendChild(lbl); para.appendChild(pt); container.appendChild(para);
    labelMap[label] = para;
  }
  return labelMap;
}

// Whole column (text + width) shrinks to fit narrow screens, so line breaks are identical on every device.
// Padding = eye-line offset, so scroll position "u" always means "this text sits on the eye line".
export function layout(viewer, st, gutter = 0){
  // side margins: ~4% of the screen width each side (min 16px), so on a phone the text is never flush against an edge
  const margin = Math.max(16, Math.round(viewer.offsetWidth * 0.04));
  const scale = Math.min(1, Math.max(0.2, (viewer.offsetWidth - gutter - 2 * margin) / st.colWidth));
  const padTop = viewer.clientHeight * (st.guidePos / 100);
  const r = document.documentElement.style;
  r.setProperty('--fontSize', st.fontSize + 'px');
  r.setProperty('--colWidthPx', st.colWidth + 'px');
  r.setProperty('--guideY', st.guidePos + '%');
  r.setProperty('--scale', scale);
  r.setProperty('--padTopPx', padTop + 'px');
  r.setProperty('--padBotPx', Math.max(0, viewer.clientHeight - padTop) + 'px');
  return { scale, padTop };
}
export const maxPos = (viewer, scale)=> Math.max(0, (viewer.scrollHeight - viewer.clientHeight) / scale);

// Playback is described by (pos, anchorMs, speed, playing): where the eye line was at a given server time.
// Every device computes the position itself, so nothing needs to stream while the script scrolls.
export function positionAt(st, serverNowMs){
  if (!st.playing) return st.pos || 0;
  return (st.pos || 0) + (st.speed || 0) * Math.max(0, serverNowMs - (st.anchorMs || serverNowMs)) / 1000;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O/1/I
export function newCode(){
  const a = new Uint32Array(8); crypto.getRandomValues(a);
  return Array.from(a, n=>ALPHABET[n % ALPHABET.length]).join('');
}
export const fmtCode = (c)=> (c || '').slice(0, 4) + '-' + (c || '').slice(4);
export const normCode = (s)=> (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Estimates (server time - local time) from write round trips, so two devices agree on "now" to within ~100 ms.
export class Clock {
  constructor(){ this.offset = 0; this.target = 0; this.samples = []; this.sent = new Map(); this.n = 0; this._t = 0; }
  // Corrections are applied gradually (max 40 ms per second) so a new estimate can never make the script visibly jump.
  _slew(){
    const t = Date.now();
    if (this._t){
      const dt = Math.min(1, (t - this._t) / 1000), d = this.target - this.offset;
      if (Math.abs(d) > 500) this.offset = this.target;                       // clocks were far apart: settle at once
      else { const step = 40 * dt; this.offset += Math.max(-step, Math.min(step, d)); }
    }
    this._t = t;
  }
  now(){ this._slew(); return Date.now() + this.offset; }
  nextPing(){ const id = ++this.n; this.sent.set(id, Date.now()); if (this.sent.size > 30) this.sent.delete(this.sent.keys().next().value); return id; }
  resolve(id, serverMs){
    const sent = this.sent.get(id); if (sent == null) return false;
    this.sent.delete(id);
    const recv = Date.now();
    this.samples.push({ off: serverMs - (sent + recv) / 2, rtt: recv - sent }); if (this.samples.length > 8) this.samples.shift();
    this.target = this.samples.reduce((best, x)=>x.rtt < best.rtt ? x : best).off;    // the quickest round trip is the most accurate
    if (this.samples.length === 1) this.offset = this.target;                          // first sync: settle at once
    return true;
  }
}

export function loadUI(){
  try{ return JSON.parse(localStorage.getItem('tp_ui') || '{}') || {}; }catch{ return {}; }
}
export const DEFAULT_SETTINGS = { fontSize:64, colWidth:1000, guidePos:35, guideVisible:true, guideLocked:false, mirror:false, flip:false, speed:80 };
