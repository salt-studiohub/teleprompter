// Mobile / tablet / laptop CONTROLLER: runs a prompter session that another device (the prompter screen) follows.
import { buildParagraphs, layout, maxPos, positionAt, newCode, fmtCode, Clock, esc, loadUI, DEFAULT_SETTINGS, SESSION_TTL_MS, MAX_TEXT } from './core.js';
import qrcode from './qrcode.mjs';   // QR generator (MIT, vendored — no network needed)
import { createCloud, db, doc, onSnapshot, updateDoc, setDoc, deleteDoc, getDoc, serverTimestamp } from './cloud.js';

const $ = (id)=>document.getElementById(id);
const viewer = $('viewer'), content = $('content'), stage = $('stage'), guide = $('guide'), grip = $('grip'), box = $('scriptBox');
const clamp = (v, a, b)=>Math.min(b, Math.max(a, v));

// ============ state (settings are remembered on this device, shared with the desktop page) ============
const st = { ...DEFAULT_SETTINGS, text:'', playing:false, pos:0, anchorMs:0 };
(function restore(){
  const u = loadUI();
  for (const k of ['fontSize','colWidth','guidePos','speed']) if (typeof u[k] === 'number') st[k] = u[k];
  for (const k of ['guideVisible','guideLocked']) if (typeof u[k] === 'boolean') st[k] = u[k];
  try{ const m = JSON.parse(localStorage.getItem('tp_ui_m') || '{}'); st.mirror = !!m.mirror; st.flip = !!m.flip; }catch{}
  try{ const t = localStorage.getItem('tp_text'); if (t) st.text = t; }catch{}
})();
function saveSettings(){
  try{
    localStorage.setItem('tp_ui', JSON.stringify({ fontSize:st.fontSize, colWidth:st.colWidth, guidePos:st.guidePos, speed:st.speed, guideVisible:st.guideVisible, guideLocked:st.guideLocked, padTB:0 }));
    localStorage.setItem('tp_ui_m', JSON.stringify({ mirror:st.mirror, flip:st.flip }));
  }catch{}
}
let toastT = null;
function notify(m){ const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('show'), 3200); }

// ============ preview (same layout rules as the prompter screen; never mirrored/flipped so it stays readable) ============
let scale = 1, padTop = 0, lastSet = 0;
const clock = new Clock();
const now = ()=>clock.now();
function setView(u){ viewer.scrollTop = Math.max(0, u) * scale; lastSet = viewer.scrollTop; }
function relayout(){
  const u = positionAt(st, now());
  guide.classList.toggle('hidden', !st.guideVisible);
  guide.classList.toggle('locked', !!st.guideLocked);
  const r = layout(viewer, st, 0); scale = r.scale; padTop = r.padTop;
  setView(u);
}
function renderText(){ buildParagraphs(st.text, content); relayout(); }
window.addEventListener('resize', ()=>{ relayout(); });

// ============ session (Firestore document that the prompter screen follows) ============
let ref = null, code = '', unsub = null, hb = null, dispSeenMs = 0, dispInfo = null, lastSeq = null;
let pend = {}, pendT = null;
const playbackFields = ()=>({ playing: st.playing, pos: st.pos, anchorMs: st.anchorMs, speed: st.speed });
function queue(fields, delay = 150){
  if (!ref) return;
  Object.assign(pend, fields);
  if (delay === 0){ clearTimeout(pendT); pendT = null; flush(); return; }
  if (!pendT) pendT = setTimeout(flush, delay);
}
async function flush(){
  pendT = null; const f = pend; pend = {};
  if (!ref || !Object.keys(f).length) return;
  try{ await updateDoc(ref, { ...f, expiresAt: new Date(Date.now() + SESSION_TTL_MS) }); }
  catch(e){ writeError(e); }
}
function writeError(e){
  console.warn('write failed', e);
  if (e && e.code === 'permission-denied'){ notify('The session expired or access was denied.'); detach(false); }
  else if (e && e.code === 'not-found'){ notify('The session no longer exists.'); detach(false); }
}
const sessionDoc = ()=>({
  text: st.text.slice(0, MAX_TEXT), fontSize: st.fontSize, colWidth: st.colWidth, guidePos: st.guidePos, guideVisible: st.guideVisible,
  guideLocked: st.guideLocked, mirror: st.mirror, flip: st.flip, ...playbackFields(),
  ownerEmail: cloud.me ? cloud.me.email : '', createdAt: serverTimestamp(), expiresAt: new Date(Date.now() + SESSION_TTL_MS), disp: {}
});
async function startSession(){
  if (!(await cloud.requireTeam())) return false;
  code = newCode(); ref = doc(db, 'sessions', code);
  try{ await setDoc(ref, sessionDoc()); }
  catch(e){
    console.error(e); ref = null; code = '';
    alert(e && e.code === 'permission-denied' ? 'Could not start a session: the Firestore rules need the "sessions" section (see the setup notes).' : 'Could not start a session. Check your internet connection.');
    return false;
  }
  attach(); notify('Session started.'); return true;
}
function attach(){
  if (unsub) unsub(); clearInterval(hb);
  try{ localStorage.setItem('tp_session_code', code); }catch{}
  lastSeq = null; dispSeenMs = 0; dispInfo = null;
  unsub = onSnapshot(ref, onSnap, (err)=>{ console.error(err); if (err && err.code === 'permission-denied'){ notify('The session expired.'); detach(false); } });
  ping(); setTimeout(ping, 500); setTimeout(ping, 1200);
  hb = setInterval(ping, 20000);
  updateChip(); renderSession();
}
async function ping(){
  if (!ref) return;
  const id = clock.nextPing();
  try{ await updateDoc(ref, { 'ctl.ping': serverTimestamp(), 'ctl.pingId': id, 'ctl.seen': serverTimestamp(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }); }
  catch(e){ writeError(e); }
}
function detach(deleteLocalCode = true){
  if (unsub){ unsub(); unsub = null; } clearInterval(hb); hb = null; ref = null; code = ''; pend = {};
  if (deleteLocalCode) try{ localStorage.removeItem('tp_session_code'); }catch{}
  else try{ localStorage.removeItem('tp_session_code'); }catch{}
  updateChip(); renderSession();
}
function onSnap(snap){
  if (!snap.exists()){ notify('The session has ended.'); detach(); return; }
  const d = snap.data({ serverTimestamps: 'estimate' });
  const mine = d.ctl;
  if (!snap.metadata.hasPendingWrites && mine && mine.pingId && mine.ping && mine.ping.toMillis) clock.resolve(mine.pingId, mine.ping.toMillis());
  const dp = d.disp || {};
  dispSeenMs = dp.seen && dp.seen.toMillis ? dp.seen.toMillis() : 0; dispInfo = dp.info || null;
  // eye line dragged on the prompter screen
  const seq = dp.guideSeq || 0;
  if (lastSeq === null) lastSeq = seq;                       // ignore anything from before we attached
  else if (seq > lastSeq){
    lastSeq = seq;
    if (!st.guideLocked && typeof dp.guide === 'number'){
      if (dp.guideFinal) setGuidePos(dp.guide);               // save it
      else document.documentElement.style.setProperty('--guideY', dp.guide + '%');   // follow the drag
    }
  }
  updateChip(); if ($('sheet-session').open) renderSession();
}
async function endSession(){
  if (!ref || !confirm('End the session? The prompter screen will disconnect.')) return;
  const r = ref; detach();
  try{ await deleteDoc(r); }catch(e){ console.warn(e); }
  notify('Session ended.');
}
async function tryResume(){
  let c = null; try{ c = localStorage.getItem('tp_session_code'); }catch{}
  if (!c) return;
  try{
    const r = doc(db, 'sessions', c); const s = await getDoc(r);
    if (!s.exists()) throw new Error('gone');
    const d = s.data({ serverTimestamps: 'estimate' });
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (d[k] !== undefined) st[k] = d[k];
    st.playing = !!d.playing; st.pos = d.pos || 0; st.anchorMs = d.anchorMs || 0; st.speed = d.speed ?? st.speed;
    if (typeof d.text === 'string'){ st.text = d.text; box.value = st.text; }
    code = c; ref = r; renderText(); attach(); updatePlayUI(); updateSettingsUI(); notify('Resumed your session.');
  }catch(e){ try{ localStorage.removeItem('tp_session_code'); }catch{} }
}

// ============ transport ============
function updatePlayUI(){ const b = $('playBtn'); b.textContent = st.playing ? '⏸ Pause' : '▶ Play'; b.classList.toggle('on', st.playing); $('spdVal').textContent = st.speed + ' px/s'; }
function rebase(){ st.pos = clamp(positionAt(st, now()), 0, maxPos(viewer, scale)); st.anchorMs = now(); }
function play(){ rebase(); st.playing = true; updatePlayUI(); queue(playbackFields(), 0); }
function pause(){ rebase(); st.playing = false; updatePlayUI(); queue(playbackFields(), 0); }
function toggle(){ st.playing ? pause() : play(); }
function seek(u){ st.pos = clamp(u, 0, maxPos(viewer, scale)); st.anchorMs = now(); setView(st.pos); queue(playbackFields(), 0); }
function setSpeed(v){
  v = clamp(Math.round(v), 10, 300);
  rebase(); st.speed = v; queue(playbackFields(), 100); saveSettings(); updatePlayUI(); updateSettingsUI();
}
const paraU = (el)=>(el.offsetTop - padTop) / scale;
function nextPara(){ const u = positionAt(st, now()); const t = [...content.children].find(p=>paraU(p) > u + 2); seek(t ? paraU(t) : maxPos(viewer, scale)); }
function prevPara(){ const u = positionAt(st, now()); let t = null; for (const p of content.children){ if (paraU(p) < u - 2) t = p; else break; } seek(t ? paraU(t) : 0); }
$('playBtn').addEventListener('click', toggle);
$('toTop').addEventListener('click', ()=>seek(0));
$('toEnd').addEventListener('click', ()=>seek(maxPos(viewer, scale)));
$('nextP').addEventListener('click', nextPara);
$('prevP').addEventListener('click', prevPara);
$('spdUp').addEventListener('click', ()=>setSpeed(st.speed + 10));
$('spdDn').addEventListener('click', ()=>setSpeed(st.speed - 10));
content.addEventListener('click', (e)=>{ const l = e.target.closest && e.target.closest('.label'); if (l) seek(paraU(l.parentElement)); });

// Preview animation: computed from the same (pos, anchor, speed) as the prompter screen; also notices manual scrolling.
function tick(){
  if (Math.abs(viewer.scrollTop - lastSet) > 1.5){            // you dragged / scrolled the preview
    st.pos = viewer.scrollTop / scale; st.anchorMs = now(); lastSet = viewer.scrollTop; queue(playbackFields(), 200);
  } else {
    const u = positionAt(st, now()), mx = maxPos(viewer, scale);
    if (st.playing && u >= mx){ st.pos = mx; st.playing = false; st.anchorMs = now(); setView(mx); queue(playbackFields(), 0); updatePlayUI(); notify('End of script.'); }
    else { viewer.scrollTop = Math.min(u, mx) * scale; lastSet = viewer.scrollTop; }
  }
  requestAnimationFrame(tick);
}

// ============ eye line ============
function setGuidePos(p){
  p = clamp(Math.round(p * 10) / 10, 2, 98);
  const oldPad = padTop; st.guidePos = p;
  const r = layout(viewer, st, 0); scale = r.scale; padTop = r.padTop;
  st.pos = Math.max(0, positionAt(st, now()) + (padTop - oldPad) / scale); st.anchorMs = now();   // text stays put while the line moves
  setView(st.pos);
  queue({ guidePos: p, ...playbackFields() }, 150); saveSettings(); updateSettingsUI();
}
(function(){
  let drag = false;
  grip.addEventListener('pointerdown', (e)=>{ if (st.guideLocked) return; drag = true; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
  grip.addEventListener('pointermove', (e)=>{ if (!drag) return; const r = stage.getBoundingClientRect(); setGuidePos((e.clientY - r.top) / r.height * 100); });
  const end = ()=>{ drag = false; };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
})();

// ============ settings sheet ============
function updateSettingsUI(){
  $('rFont').value = st.fontSize; $('vFont').textContent = st.fontSize + 'px';
  $('rCol').value = st.colWidth; $('vCol').textContent = st.colWidth + 'px';
  $('rGuide').value = st.guidePos; $('vGuide').textContent = st.guidePos + '%';
  $('rSpeed').value = st.speed; $('vSpeed').textContent = st.speed + ' px/s';
  $('cGuide').checked = !!st.guideVisible; $('cLock').checked = !!st.guideLocked; $('cMirror').checked = !!st.mirror; $('cFlip').checked = !!st.flip;
  $('rGuide').disabled = !!st.guideLocked;
}
function setSetting(k, v){ st[k] = v; if (k === 'fontSize' || k === 'colWidth' || k === 'guideVisible' || k === 'guideLocked') relayout(); queue({ [k]: v }, 150); saveSettings(); updateSettingsUI(); }
$('rFont').addEventListener('input', (e)=>setSetting('fontSize', +e.target.value));
$('rCol').addEventListener('input', (e)=>setSetting('colWidth', +e.target.value));
$('rGuide').addEventListener('input', (e)=>setGuidePos(+e.target.value));
$('rSpeed').addEventListener('input', (e)=>setSpeed(+e.target.value));
$('cGuide').addEventListener('change', (e)=>setSetting('guideVisible', e.target.checked));
$('cLock').addEventListener('change', (e)=>setSetting('guideLocked', e.target.checked));
$('cMirror').addEventListener('change', (e)=>setSetting('mirror', e.target.checked));
$('cFlip').addEventListener('change', (e)=>setSetting('flip', e.target.checked));

// ============ script + library ============
function applyText(text){            // replace the script (e.g. opened from the library): rewind and pause
  st.text = text || ''; box.value = st.text; st.playing = false; st.pos = 0; st.anchorMs = now();
  renderText(); setView(0); updatePlayUI(); charInfo();
  try{ localStorage.setItem('tp_text', st.text); }catch{}
  queue({ text: st.text.slice(0, MAX_TEXT), ...playbackFields() }, 0);
}
function charInfo(){ const n = box.value.length; $('charInfo').textContent = `${n.toLocaleString()} characters` + (n > MAX_TEXT ? ' — too long to sync to the prompter screen' : ''); }
function curName(){ const n = cloud.currentLabel(); $('curName').textContent = n ? `Saved script: ${n}` : 'Not saved yet'; $('libCur').textContent = n ? `Current: ${n}` : 'The current script is not saved yet'; }
box.addEventListener('input', ()=>{
  st.text = box.value; renderText(); charInfo();
  try{ localStorage.setItem('tp_text', st.text); }catch{}
  queue({ text: st.text.slice(0, MAX_TEXT) }, 400);
});

const cloud = createCloud({
  getText: ()=>box.value,
  setText: applyText,
  notify,
  changed: ()=>{ updateGate(); curName(); }
});

$('btnSave').addEventListener('click', ()=>cloud.save());
$('btnSaveAs').addEventListener('click', ()=>cloud.saveAs());
$('libSave').addEventListener('click', ()=>cloud.save());
$('libSaveAs').addEventListener('click', ()=>cloud.saveAs());
$('btnOpen').addEventListener('click', ()=>{ $('sheet-script').close(); openSheet('library'); });

async function renderLibrary(){
  curName();
  const el = $('libList');
  if (!(cloud.me && cloud.isMember)){ el.innerHTML = '<div class="muted">Sign in to see the library.</div>'; return; }
  el.innerHTML = '<div class="muted">Loading…</div>';
  try{
    const rows = await cloud.list();
    el.innerHTML = rows.length ? '' : '<div class="muted">No saved scripts yet.</div>';
    rows.forEach((r)=>{
      const d = document.createElement('div'); d.className = 'item';
      d.innerHTML = `<div><div class="t">${esc(r.name)}</div><div class="muted">${esc(r.when)}</div></div>
        <div class="rowbtns"><button class="primary" data-a="open" data-id="${esc(r.id)}">Open</button><button data-a="rename" data-id="${esc(r.id)}">Rename</button><button data-a="dup" data-id="${esc(r.id)}">Duplicate</button><button data-a="del" data-id="${esc(r.id)}">Delete</button></div>`;
      el.appendChild(d);
    });
  }catch(e){ console.error(e); el.innerHTML = '<div class="muted">Could not load the library.</div>'; }
}
$('libList').addEventListener('click', async (e)=>{
  const a = e.target.dataset && e.target.dataset.a, id = e.target.dataset && e.target.dataset.id; if (!a) return;
  try{
    if (a === 'open'){ if (await cloud.open(id)){ $('sheet-library').close(); } }
    else if (a === 'rename'){ if (await cloud.rename(id)) renderLibrary(); }
    else if (a === 'dup'){ if (await cloud.duplicate(id)){ notify('Duplicated.'); renderLibrary(); } }
    else if (a === 'del'){ if (await cloud.remove(id)) renderLibrary(); }
  }catch(err){ console.error(err); alert('That did not work. See console for details.'); }
});

// ============ session sheet ============
function qrSvg(text){
  try{ const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: 'QR code that opens the prompter screen' }); }
  catch(e){ console.warn('QR failed', e); return ''; }
}
const displayUrl = ()=> new URL('display.html', location.href).href;
function updateChip(){
  const chip = $('sessChip');
  if (!ref){ chip.textContent = '○ No session — tap to start'; chip.classList.remove('live'); return; }
  const ok = dispSeenMs && now() - dispSeenMs < 25000;
  chip.textContent = `${ok ? '●' : '○'} ${fmtCode(code)} · ${ok ? 'prompter screen connected' : 'waiting for prompter screen'}`;
  chip.classList.toggle('live', !!ok);
}
setInterval(()=>{ updateChip(); if ($('sheet-session').open) renderSession(); }, 4000);
function renderSession(){
  const body = $('sessBody');
  if (!ref){
    body.innerHTML = `<p class="muted">Start a session, then open the prompter screen on another device (iPad, phone or laptop) and enter the code. You control the script from here; the other screen just follows.</p>
      <button class="primary" id="sStart">Start session</button>`;
    $('sStart').onclick = async ()=>{ await startSession(); renderSession(); };
    return;
  }
  const link = `${displayUrl()}?code=${code}`;
  const ok = dispSeenMs && now() - dispSeenMs < 25000;
  body.innerHTML = `<div class="code">${fmtCode(code)}</div>
    <div class="status"><span class="dot ${ok ? 'on' : ''}"></span>${ok ? 'Prompter screen connected' : 'Waiting for the prompter screen…'}</div>
    ${ok && dispInfo ? `<div class="muted" style="text-align:center">${dispInfo.w}×${dispInfo.h}${dispInfo.fs ? ' · fullscreen' : ''}</div>` : ''}
    <div class="qr">${qrSvg(link)}</div>
    <p class="muted" style="text-align:center">Scan with the other device's camera to open the prompter screen already joined — or open <b>${esc(displayUrl())}</b> and enter the code, or send this link:</p>
    <input type="text" id="sLink" readonly value="${esc(link)}">
    <div class="rowbtns"><button id="sCopy">Copy link</button>${navigator.share ? '<button id="sShare">Share…</button>' : ''}</div>
    <button class="danger" id="sEnd">End session</button>`;
  $('sCopy').onclick = async ()=>{ try{ await navigator.clipboard.writeText(link); notify('Link copied.'); }catch{ $('sLink').select(); document.execCommand && document.execCommand('copy'); notify('Link copied.'); } };
  if ($('sShare')) $('sShare').onclick = ()=>navigator.share({ title: 'Teleprompter screen', url: link }).catch(()=>{});
  $('sEnd').onclick = endSession;
}
$('sessChip').addEventListener('click', ()=>openSheet('session'));

// ============ team (admin) ============
async function renderTeam(){
  const el = $('teamList'); el.innerHTML = '<div class="muted">Loading…</div>';
  try{
    const rows = await cloud.members();
    el.innerHTML = rows.length ? '' : '<div class="muted">No team members yet. Add emails above — you, the admin, always have access.</div>';
    rows.forEach((email)=>{ const d = document.createElement('div'); d.className = 'item'; d.innerHTML = `<div class="t">${esc(email)}</div><button data-email="${esc(email)}">Remove</button>`; el.appendChild(d); });
  }catch(e){ console.error(e); el.innerHTML = '<div class="muted">Could not load the team list (admin only).</div>'; }
}
$('teamAdd').addEventListener('click', async ()=>{
  try{ $('teamMsg').textContent = await cloud.addMembers($('teamEmail').value); if (!/^(No email|Not valid)/.test($('teamMsg').textContent)) $('teamEmail').value = ''; renderTeam(); }
  catch(e){ console.error(e); $('teamMsg').textContent = 'Could not add members. Only the admin can change the team.'; }
});
$('teamList').addEventListener('click', async (e)=>{ const email = e.target.dataset && e.target.dataset.email; if (!email) return; try{ if (await cloud.removeMember(email)) renderTeam(); }catch(err){ console.error(err); alert('Could not remove that member.'); } });

// ============ sheets, gate, account ============
function openSheet(name){
  const dlg = $('sheet-' + name); if (!dlg) return;
  if (name === 'library') renderLibrary();
  if (name === 'session') renderSession();
  if (name === 'team') renderTeam();
  if (name === 'settings') updateSettingsUI();
  if (name === 'script'){ charInfo(); curName(); }
  if (!dlg.open) dlg.showModal();
}
document.querySelectorAll('[data-sheet]').forEach((b)=>b.addEventListener('click', ()=>openSheet(b.dataset.sheet)));
document.querySelectorAll('dialog.sheet').forEach((d)=>{
  d.addEventListener('click', (e)=>{ if (e.target === d) d.close(); });
  d.querySelectorAll('[data-close]').forEach((b)=>b.addEventListener('click', ()=>d.close()));
});
function updateGate(){
  const g = $('gate'), ok = cloud.me && cloud.isMember;
  $('teamTab').hidden = !cloud.isAdmin;
  g.hidden = !!ok; if (ok) return;
  $('gateGo').hidden = false;
  if (!cloud.me){ $('gateMsg').textContent = 'Sign in with Google to run a prompter session.'; $('gateGo').textContent = 'Sign in with Google'; }
  else { $('gateMsg').innerHTML = `You're signed in as <b>${esc(cloud.me.email)}</b>, but that email isn't on the team list. Ask the admin to add it, or use a different Google account.`; $('gateGo').textContent = 'Use a different account'; }
}
$('gateGo').addEventListener('click', async ()=>{ if (cloud.me) await cloud.signOut(); await cloud.signIn(); });
$('acctBtn').addEventListener('click', async ()=>{
  if (!cloud.me){ cloud.signIn(); return; }
  if (confirm(`Signed in as ${cloud.me.email}.\n\nSign out?`)){ detach(false); await cloud.signOut(); }
});
$('toDesktop').addEventListener('click', ()=>{ try{ localStorage.setItem('tp_mode', 'desktop'); }catch{} });

// ============ keyboard (laptop / iPad keyboard) ============
document.addEventListener('keydown', (e)=>{
  if (document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  const k = e.key, big = viewer.clientHeight * 0.9 / scale, cur = positionAt(st, now());
  if (![' ','ArrowUp','ArrowDown','+','=','-','_','[',']','Home','End','PageUp','PageDown','g','G'].includes(k)) return;
  e.preventDefault();
  if (k === ' ') toggle();
  else if (k === 'ArrowUp') seek(cur - 60 / scale);
  else if (k === 'ArrowDown') seek(cur + 60 / scale);
  else if (k === 'PageUp') seek(cur - big);
  else if (k === 'PageDown') seek(cur + big);
  else if (k === 'Home') seek(0);
  else if (k === 'End') seek(maxPos(viewer, scale));
  else if (k === '+' || k === '=' || k === ']') setSpeed(st.speed + 10);
  else if (k === '-' || k === '_' || k === '[') setSpeed(st.speed - 10);
  else if (k === 'g' || k === 'G') setSetting('guideVisible', !st.guideVisible);
});

// ============ start ============
(async function init(){
  box.value = st.text; renderText(); updatePlayUI(); updateSettingsUI(); charInfo(); curName();
  $('gate').hidden = false; $('gateGo').hidden = true; $('gateMsg').textContent = 'Checking sign-in…';
  requestAnimationFrame(tick);
  await cloud.ready; updateGate();
  if (cloud.me && cloud.isMember) await tryResume();
})();
