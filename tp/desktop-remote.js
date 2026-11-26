// Desktop operator -> REMOTE presenter window (tablet / phone) over the internet.
// The desktop page keeps working exactly as before; this module only mirrors what it already sends to its popup window.
// Loaded lazily by index.html (if it can't load, e.g. offline, the button just opens the local window).
import qrcode from './qrcode.mjs';
import { createSession } from './session.js';
import { esc, MAX_TEXT, positionAt } from './core.js';

const H = window.tpHost;                 // provided by index.html
const S = H.state;
const $ = (id)=>document.getElementById(id);
const ico = (n)=>`<svg class="ico" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const notify = (m)=>{ const el = $('status'); if (el) el.textContent = m; };

// ---------- what we have already written to the session ----------
let pb = { playing: false, pos: 0, anchorMs: 0, speed: 80 };
let lastText = null, lastSettings = '';
const settings = ()=>({ fontSize: S.fontSize, colWidth: S.colWidth, guidePos: S.guidePos, guideVisible: S.guideVisible, guideLocked: S.guideLocked, mirror: !!S.invertH, flip: !!S.invertV, speed: S.speed });
const now = ()=>sess.clock.now();

const sess = createSession({
  getDoc: ()=>{ pb = { playing: !!S.autoscroll, pos: S.scrollTop || 0, anchorMs: now(), speed: S.speed }; lastText = S.text; lastSettings = JSON.stringify(settings()); return { text: S.text.slice(0, MAX_TEXT), ...settings(), ...pb }; },
  requireTeam: ()=>H.requireTeam(),
  ownerEmail: ()=>{ const m = H.me(); return m ? m.email : ''; },
  isPlaying: ()=>!!S.autoscroll,
  onGuide: (p, final)=>{
    if (S.guideLocked) return;
    if (final) H.setGuide(p); else H.previewGuide(p);       // dragged on the presenter window: follow, then save
  },
  onChange: ()=>{ renderChip(); if ($('presenterDialog').open) renderDialog(); },
  notify
});

// ---------- mirror the desktop's messages (the same ones it sends to its popup) ----------
function pushAll(){
  pb = { playing: !!S.autoscroll, pos: S.scrollTop || 0, anchorMs: now(), speed: S.speed };
  lastText = S.text; lastSettings = JSON.stringify(settings());
  sess.queue({ text: S.text.slice(0, MAX_TEXT), ...settings(), ...pb }, 0);
}
H.onSend = (msg)=>{
  if (!sess.active || !msg) return;
  if (msg.type === 'state'){
    const f = {};
    if (S.text !== lastText){ lastText = S.text; f.text = S.text.slice(0, MAX_TEXT); }
    const cur = JSON.stringify(settings());
    if (cur !== lastSettings){ lastSettings = cur; Object.assign(f, settings()); }
    if (!!S.autoscroll !== pb.playing || S.speed !== pb.speed){            // play / pause / speed change
      pb = { playing: !!S.autoscroll, pos: S.scrollTop || 0, anchorMs: now(), speed: S.speed };
      Object.assign(f, pb); sess.queue(f, 0); sess.scheduleBeat(); if (pb.playing) sess.ping(); return;
    }
    if (!pb.playing && Math.abs((S.scrollTop || 0) - pb.pos) > 0.5){ pb.pos = S.scrollTop || 0; pb.anchorMs = now(); Object.assign(f, { pos: pb.pos, anchorMs: pb.anchorMs, playing: false }); }
    if (Object.keys(f).length) sess.queue(f, 250);
  } else if (msg.type === 'scroll'){
    const u = msg.scrollTop || 0;
    if (!pb.playing){
      if (Math.abs(u - pb.pos) > 0.5){ pb.pos = u; pb.anchorMs = now(); sess.queue({ pos: u, anchorMs: pb.anchorMs, playing: false }, 150); }
    } else {                                                                // playing: only react to a manual jump / drag
      const expected = pb.pos + pb.speed * Math.max(0, now() - pb.anchorMs) / 1000;
      if (Math.abs(u - expected) > Math.max(25, pb.speed * 0.4)){ pb.pos = u; pb.anchorMs = now(); sess.queue({ pos: u, anchorMs: pb.anchorMs, playing: true, speed: pb.speed }, 100); }
    }
  } else if (msg.type === 'guidePos'){
    pb.pos = msg.scrollTop || 0; pb.anchorMs = now(); lastSettings = JSON.stringify(settings());
    sess.queue({ guidePos: msg.guidePos, pos: pb.pos, anchorMs: pb.anchorMs }, 120);
  }
};

// ---------- UI: status chip + dialog ----------
const css = document.createElement('style');
css.textContent = `
  #remoteChip{cursor:pointer;border:1px solid #333;border-radius:999px;padding:6px 11px;font-size:13px;background:#121212;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}
  #remoteChip.live{border-color:#2e7d32} #remoteChip.warn{border-color:#d32f2f}
  #presenterDialog .pd-choice{padding:14px 16px;font-size:15px;text-align:left;width:100%}
  #presenterDialog .code{font-size:38px;font-weight:800;letter-spacing:.12em;text-align:center;padding:4px 0}
  #presenterDialog .status{display:flex;align-items:center;gap:8px;justify-content:center;font-size:15px}
  #presenterDialog .dot{width:10px;height:10px;border-radius:50%;background:#777} #presenterDialog .dot.on{background:#43a047}
  #presenterDialog .qr{background:#fff;padding:8px;border-radius:14px;width:230px;margin:10px auto}
  #presenterDialog .qr svg{display:block;width:100%;height:auto}
  #presenterDialog .rowbtns{display:flex;gap:8px;flex-wrap:wrap} #presenterDialog .rowbtns button{flex:1}
  #presenterDialog input[type=text]{width:100%;background:#0a0a0a;color:#fff;border:1px solid #222;border-radius:10px;padding:9px;font-size:14px}
`;
document.head.appendChild(css);

const chip = document.createElement('span');
chip.id = 'remoteChip'; chip.hidden = true; chip.title = 'Presenter window on a tablet or phone';
document.querySelector('.tb-actions')?.prepend(chip);
chip.addEventListener('click', ()=>choose());
function renderChip(){
  if (!sess.active){ chip.hidden = true; return; }
  chip.hidden = false;
  const off = sess.offline(), ok = sess.displayConnected();
  chip.innerHTML = off ? `${ico('warn')} ${sess.fmt()} · OFFLINE — presenter will hold its position` : `${ico('phone')} ${sess.fmt()} · ${ok ? 'presenter connected' : 'waiting for presenter'}`;
  chip.classList.toggle('live', ok && !off); chip.classList.toggle('warn', off);
}
setInterval(()=>{ renderChip(); if ($('presenterDialog').open && sess.active) renderDialog(); }, 2000);

function qrSvg(text){
  try{ const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: 'QR code that opens the presenter window' }); }
  catch(e){ console.warn('QR failed', e); return ''; }
}
function renderDialog(){
  const body = $('pdBody');
  if (!sess.active){
    let last = 'local'; try{ last = localStorage.getItem('tp_pd_choice') || 'local'; }catch{}
    body.innerHTML = `<p class="muted" style="margin:2px 0 12px;font-size:14px;line-height:1.5">Where will the presenter window be?</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="pd-choice" id="pdLocal"><b>${ico('monitor')} On this computer</b><br><span class="muted">Opens a window you can drag to a second monitor.</span></button>
        <button class="pd-choice" id="pdRemote"><b>${ico('phone')} On a tablet or phone</b><br><span class="muted">Shows a QR code. Works over the internet — the devices don't need to be on the same network.</span></button>
      </div>`;
    $('pdLocal').onclick = ()=>{ try{ localStorage.setItem('tp_pd_choice', 'local'); }catch{} $('presenterDialog').close(); H.openLocal(); };
    $('pdRemote').onclick = async ()=>{ try{ localStorage.setItem('tp_pd_choice', 'remote'); }catch{} if (await sess.start()){ pushAll(); renderDialog(); } };
    $(last === 'remote' ? 'pdRemote' : 'pdLocal').focus();
    return;
  }
  const link = sess.link(), ok = sess.displayConnected(), info = sess.dispInfo;
  body.innerHTML = `<div class="code">${sess.fmt()}</div>
    <div class="status"><span class="dot ${ok ? 'on' : ''}"></span>${ok ? 'Presenter window connected' : 'Waiting for the presenter window…'}</div>
    ${ok && info ? `<div class="muted" style="text-align:center">${info.w}×${info.h}${info.fs ? ' · fullscreen' : ''}</div>` : ''}
    <div class="qr">${qrSvg(link)}</div>
    <p class="muted" style="text-align:center;line-height:1.5">Scan with the tablet or phone's camera to open the presenter window already joined — or open <b>${esc(sess.displayUrl())}</b> and enter the code.</p>
    <input type="text" id="pdLink" readonly value="${esc(link)}">
    <div class="rowbtns" style="margin-top:8px"><button id="pdCopy">Copy link</button><button id="pdLocal2">Also open on this computer</button><button id="pdEnd" style="background:#7a1f1f;border-color:#a33">End</button></div>`;
  $('pdCopy').onclick = async ()=>{ try{ await navigator.clipboard.writeText(link); notify('Link copied.'); }catch{ $('pdLink').select(); document.execCommand && document.execCommand('copy'); } };
  $('pdLocal2').onclick = ()=>{ $('presenterDialog').close(); H.openLocal(); };
  $('pdEnd').onclick = async ()=>{ if (confirm('End the presenter window? The tablet or phone will disconnect.')){ await sess.end(); renderDialog(); } };
}
$('pdClose')?.addEventListener('click', ()=>$('presenterDialog').close());

export function choose(){ renderDialog(); if (!$('presenterDialog').open) $('presenterDialog').showModal(); }
export const session = sess;

// ---------- reload / sign-out ----------
let resumed = false;
async function onAuth(){
  if (!H.me()){ if (sess.active) sess.detach(); resumed = false; return; }
  if (resumed || !H.isMember()) return;
  resumed = true;
  const d = await sess.resume();                  // a remote presenter window was running (page reload, or switched from the mobile interface)
  if (d){
    // Carry on from where the session is: same position, same play/pause state. Text/settings from this device win.
    pb = { playing: !!d.playing, pos: d.pos || 0, anchorMs: d.anchorMs || now(), speed: d.speed ?? S.speed };
    lastText = typeof d.text === 'string' ? d.text : null;
    lastSettings = JSON.stringify({ fontSize: d.fontSize, colWidth: d.colWidth, guidePos: d.guidePos, guideVisible: d.guideVisible, guideLocked: d.guideLocked, mirror: !!d.mirror, flip: !!d.flip, speed: d.speed });
    const u = pb.playing ? positionAt(pb, now()) : pb.pos;
    H.adopt(u, pb.playing, pb.speed);              // re-renders and broadcasts; any text/settings difference is pushed by the normal diff
    sess.scheduleBeat();
  }
}
document.addEventListener('tp-auth', onAuth);
onAuth();
