// Live session between a CONTROLLER (tablet controller page, or the desktop operator) and a remote PRESENTER window.
// The controller owns the state; the presenter window follows. UI-agnostic: the host supplies the callbacks.
import { Clock, SESSION_TTL_MS, MAX_TEXT, newCode, fmtCode } from './core.js';
import { db, doc, onSnapshot, updateDoc, setDoc, deleteDoc, getDoc, serverTimestamp } from './cloud.js';

/**
 * host: {
 *   getDoc():object                 fields to create the session with (text, settings, playback)
 *   requireTeam():Promise<boolean>  must be signed in as a team member to start a session
 *   ownerEmail():string
 *   isPlaying():boolean
 *   onGuide(p:number, final:boolean) the presenter window's eye line was dragged
 *   onChange():void                  status changed (connected / offline / ended)
 *   notify(msg:string):void
 * }
 */
export function createSession(host){
  const s = {
    clock: new Clock(), ref: null, code: '', dispSeenMs: 0, dispInfo: null, lastAck: 0,
    get active(){ return !!this.ref; }
  };
  let unsub = null, hb = null, lastSeq = null, pend = {}, pendT = null, pingBusy = false, pingAt = 0;
  const LS = 'tp_session_code';
  const changed = ()=>host.onChange && host.onChange();
  const notify = (m)=>host.notify && host.notify(m);

  s.link = ()=> `${new URL('display.html', location.href).href}?code=${s.code}`;
  s.displayUrl = ()=> new URL('display.html', location.href).href;
  s.fmt = ()=> fmtCode(s.code);
  s.displayConnected = ()=> !!(s.dispSeenMs && s.clock.now() - s.dispSeenMs < 25000);
  s.offline = ()=> !!(s.ref && host.isPlaying() && Date.now() - s.lastAck > 10000);   // our check-ins are not getting through

  // ----- writes (batched; always extends the session's expiry) -----
  s.queue = (fields, delay = 150)=>{
    if (!s.ref) return;
    Object.assign(pend, fields);
    if (delay === 0){ clearTimeout(pendT); pendT = null; flush(); return; }
    if (!pendT) pendT = setTimeout(flush, delay);
  };
  async function flush(){
    pendT = null; const f = pend; pend = {};
    if (!s.ref || !Object.keys(f).length) return;
    if (typeof f.text === 'string') f.text = f.text.slice(0, MAX_TEXT);
    try{ await updateDoc(s.ref, { ...f, expiresAt: new Date(Date.now() + SESSION_TTL_MS) }); }
    catch(e){ writeError(e); }
  }
  function writeError(e){
    console.warn('session write failed', e);
    if (e && e.code === 'permission-denied'){ notify('The presenter session expired or access was denied.'); s.detach(); }
    else if (e && e.code === 'not-found'){ notify('The presenter session no longer exists.'); s.detach(); }
  }

  // ----- check-ins: every 3 s while playing (so the presenter window can hold if we vanish), every 20 s otherwise -----
  async function ping(){
    if (!s.ref) return;
    if (pingBusy && Date.now() - pingAt < 12000) return;       // don't pile up check-ins while offline
    pingBusy = true; pingAt = Date.now();
    const id = s.clock.nextPing();
    try{ await updateDoc(s.ref, { 'ctl.ping': serverTimestamp(), 'ctl.pingId': id, 'ctl.seen': serverTimestamp(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }); s.lastAck = Date.now(); }
    catch(e){ writeError(e); }
    finally{ pingBusy = false; }
  }
  s.ping = ping;
  s.scheduleBeat = ()=>{
    clearTimeout(hb);
    hb = setTimeout(()=>{ if (!s.ref) return; ping(); s.scheduleBeat(); }, host.isPlaying() ? 3000 : 20000);   // never wait on a hung write
  };

  // ----- lifecycle -----
  s.attach = (code, ref)=>{
    if (unsub) unsub(); clearTimeout(hb);
    s.code = code; s.ref = ref;
    try{ localStorage.setItem(LS, code); }catch{}
    lastSeq = null; s.dispSeenMs = 0; s.dispInfo = null; s.lastAck = Date.now();
    unsub = onSnapshot(ref, onSnap, (err)=>{ console.error(err); if (err && err.code === 'permission-denied'){ notify('The presenter session expired.'); s.detach(); } });
    ping(); setTimeout(ping, 500); setTimeout(ping, 1200);
    s.scheduleBeat(); changed();
  };
  s.detach = ()=>{
    if (unsub){ unsub(); unsub = null; } clearTimeout(hb); hb = null; clearTimeout(pendT); pendT = null; pend = {};
    s.ref = null; s.code = '';
    try{ localStorage.removeItem(LS); }catch{}
    changed();
  };
  s.start = async ()=>{
    if (!(await host.requireTeam())) return false;
    const code = newCode(), ref = doc(db, 'sessions', code);
    try{ await setDoc(ref, { ...host.getDoc(), ownerEmail: host.ownerEmail() || '', createdAt: serverTimestamp(), expiresAt: new Date(Date.now() + SESSION_TTL_MS), disp: {} }); }
    catch(e){
      console.error(e);
      alert(e && e.code === 'permission-denied' ? 'Could not start a presenter session: the Firestore rules need the "sessions" section (see the setup notes).' : 'Could not start a presenter session. Check your internet connection.');
      return false;
    }
    s.attach(code, ref); notify('Presenter window ready.'); return true;
  };
  s.end = async ()=>{
    if (!s.ref) return;
    const r = s.ref; s.detach();
    try{ await deleteDoc(r); }catch(e){ console.warn(e); }
    notify('Presenter session ended.');
  };
  // Re-attach to the session this device last ran (after a page reload). Returns the stored doc data (host loads it) or null.
  s.resume = async ()=>{
    let c = null; try{ c = localStorage.getItem(LS); }catch{}
    if (!c) return null;
    try{
      const r = doc(db, 'sessions', c); const snap = await getDoc(r);
      if (!snap.exists()) throw new Error('gone');
      const d = snap.data({ serverTimestamps: 'estimate' });
      s.attach(c, r); return d;
    }catch(e){ try{ localStorage.removeItem(LS); }catch{} return null; }
  };

  function onSnap(snap){
    if (!snap.exists()){ notify('The presenter session has ended.'); s.detach(); return; }
    const d = snap.data({ serverTimestamps: 'estimate' });
    const mine = d.ctl;
    if (!snap.metadata.hasPendingWrites && mine && mine.pingId && mine.ping && mine.ping.toMillis) s.clock.resolve(mine.pingId, mine.ping.toMillis());
    const dp = d.disp || {};
    s.dispSeenMs = dp.seen && dp.seen.toMillis ? dp.seen.toMillis() : 0; s.dispInfo = dp.info || null;
    const seq = dp.guideSeq || 0;                              // eye line dragged on the presenter window
    if (lastSeq === null) lastSeq = seq;                       // ignore anything from before we attached
    else if (seq > lastSeq){ lastSeq = seq; if (typeof dp.guide === 'number' && host.onGuide) host.onGuide(dp.guide, !!dp.guideFinal); }
    changed();
  }
  return s;
}
