// Sign-in, team membership and the saved-script library for the mobile controller.
// (Same behaviour and Firestore data as the desktop page: scripts in "publicScripts", team in "members".)
import { firebaseConfig, esc } from './core.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, getDoc, doc, deleteDoc, updateDoc, setDoc,
  serverTimestamp, query, orderBy, where, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

export { doc, onSnapshot, updateDoc, setDoc, deleteDoc, getDoc, serverTimestamp };
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const COLL = 'publicScripts';      // shared with the whole team (default)
const PRIV = 'privateScripts';     // tagged Private: only the owner (and the admin) can open
const EMAIL_RE = /^[^\s@\/]+@[^\s@\/]+\.[^\s@\/]+$/;

/**
 * hooks: { getText():string, setText(text:string), notify(msg:string), changed():void }
 */
export function createCloud(hooks){
  const c = { me: null, isMember: false, isAdmin: false, currentDocId: null, currentColl: COLL, currentName: '', savedText: '', wantPrivate: false };
  const notify = (m)=>hooks.notify && hooks.notify(m);
  const changed = ()=>hooks.changed && hooks.changed();

  try{ const m = JSON.parse(localStorage.getItem('tp_doc_meta') || 'null'); if (m && m.id){ c.currentDocId = m.id; c.currentName = m.name || ''; c.savedText = typeof m.savedText === 'string' ? m.savedText : ''; c.currentColl = m.coll === PRIV ? PRIV : COLL; c.wantPrivate = c.currentColl === PRIV; } }catch{}
  const rememberMeta = ()=>{ try{ localStorage.setItem('tp_doc_meta', JSON.stringify({ id: c.currentDocId, name: c.currentName, savedText: c.savedText, coll: c.currentColl })); }catch{} };

  // ---------- auth ----------
  async function refreshRole(user){
    c.isMember = false; c.isAdmin = false;
    if (!user) return;
    const email = (user.email || '').toLowerCase();
    try{ await getDocs(collection(db, 'members')); c.isAdmin = true; c.isMember = true; return; }catch{}
    try{ const d = await getDoc(doc(db, 'members', email)); c.isMember = d.exists(); }catch{ c.isMember = false; }
  }
  function authError(err){
    if (!err || err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    console.error(err);
    alert(err.code === 'auth/unauthorized-domain' ? "Sign-in blocked: add this site's domain under Firebase Console → Authentication → Settings → Authorized domains."
        : err.code === 'auth/operation-not-allowed' ? 'Google sign-in is not enabled: Firebase Console → Authentication → Sign-in method → Google → Enable.'
        : err.code === 'auth/popup-blocked' ? 'The sign-in pop-up was blocked. Allow pop-ups for this site and try again.'
        : 'Sign-in failed. See console for details.');
  }
  c.signIn = async ()=>{ try{ await signInWithPopup(auth, provider); }catch(err){ authError(err); } };
  c.signOut = ()=>signOut(auth).catch(console.error);
  c.ready = new Promise((resolve)=>{
    let first = true;
    onAuthStateChanged(auth, async (user)=>{
      c.me = user || null; await refreshRole(c.me); changed();
      if (first){ first = false; resolve(); }
    });
  });
  c.requireTeam = async ()=>{
    if (!c.me){ notify('Sign in with Google first.'); await c.signIn(); return false; }
    if (!c.isMember){ alert(`${c.me.email} is not on the team list.\n\nAsk the admin to add this email under Team.`); return false; }
    return true;
  };

  // ---------- library ----------
  // Scripts are shared with the whole team by default; tagging one Private keeps it in an owner-only area (the admin can also open it).
  c.currentLabel = ()=> c.currentDocId ? (c.currentName || '(untitled)') : '';
  c.currentPrivate = ()=> c.currentDocId ? c.currentColl === PRIV : !!c.wantPrivate;
  c.setPrivate = (v)=>{ c.wantPrivate = !!v; changed(); };
  c.markSaved = (text)=>{ c.savedText = text; rememberMeta(); };
  const wantColl = ()=> c.wantPrivate ? PRIV : COLL;
  const body = (name, text, coll, extra)=>({ name, text, owner: c.me ? (c.me.email || '').toLowerCase() : '', private: coll === PRIV, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(extra || {}) });

  c.saveAs = async ()=>{
    if (!(await c.requireTeam())) return false;
    const text = hooks.getText();
    const name = prompt('Save as — enter a name for the new script:', c.currentName ? `${c.currentName} (copy)` : '');
    if (name === null) return false;
    const trimmed = (name || '').trim();
    if (!trimmed){ alert('Please enter a valid name.'); return false; }
    const coll = wantColl();
    try{
      const ref = await addDoc(collection(db, coll), body(trimmed, text, coll));
      c.currentDocId = ref.id; c.currentName = trimmed; c.currentColl = coll; c.wantPrivate = coll === PRIV; c.savedText = text; rememberMeta();
      notify(`Saved “${trimmed}” as a new ${coll === PRIV ? 'private' : 'shared'} script.`); changed(); return true;
    }catch(err){ console.error(err); alert('Save As failed. See console for details.'); return false; }
  };

  c.save = async ()=>{
    if (!(await c.requireTeam())) return false;
    if (!c.currentDocId) return c.saveAs();
    const text = hooks.getText(), coll = wantColl();
    try{
      const cur = await getDoc(doc(db, c.currentColl, c.currentDocId));
      if (!cur.exists()) return c.saveAs();
      if (coll === c.currentColl){
        await updateDoc(doc(db, c.currentColl, c.currentDocId), { text, updatedAt: serverTimestamp() });
        notify(`Saved “${c.currentName}”.`);
      } else {                                                    // visibility changed: move it to the other area
        const old = cur.data();
        const ref = await addDoc(collection(db, coll), body(c.currentName, text, coll, { createdAt: old.createdAt || serverTimestamp() }));
        await deleteDoc(doc(db, c.currentColl, c.currentDocId));
        c.currentDocId = ref.id; c.currentColl = coll;
        notify(`“${c.currentName}” is now ${coll === PRIV ? 'private (only you and the admin can open it)' : 'shared with the team'}.`);
      }
      c.wantPrivate = c.currentColl === PRIV; c.savedText = text; rememberMeta(); changed(); return true;
    }catch(err){ console.error(err); alert('Save failed. See console for details.'); return false; }
  };

  // Before opening another script: keep the current one (autosave into its script, or ask to save an unsaved one).
  async function persistBeforeSwitch(){
    const text = hooks.getText();
    if (c.currentDocId){
      if (text === c.savedText) return true;
      try{
        await updateDoc(doc(db, c.currentColl, c.currentDocId), { text, updatedAt: serverTimestamp() });
        c.savedText = text; rememberMeta(); notify(`Autosaved “${c.currentName}”.`); return true;
      }catch(err){
        console.error(err);
        return confirm(`Could not save your changes to “${c.currentName}”.\n\nOpen the other script anyway and lose those changes?`);
      }
    }
    if (!text.trim()) return true;
    const name = prompt("The current script hasn't been saved yet.\n\nEnter a name to save it before opening another script.\n(Cancel for more options.)", '');
    if (name === null) return confirm('Discard the unsaved script and open the other one instead?');
    const trimmed = (name || '').trim();
    if (!trimmed){ alert('Please enter a name to save the current script. Nothing was opened.'); return false; }
    const coll = wantColl();
    try{
      const ref = await addDoc(collection(db, coll), body(trimmed, text, coll));
      c.currentDocId = ref.id; c.currentName = trimmed; c.currentColl = coll; c.wantPrivate = coll === PRIV; c.savedText = text; rememberMeta(); notify(`Saved “${trimmed}”.`); return true;
    }catch(err){ console.error(err); return confirm('Could not save the current script.\n\nOpen the other script anyway and lose it?'); }
  }

  const when = (v)=> v.updatedAt && v.updatedAt.toDate ? v.updatedAt.toDate().toLocaleString() : '';
  const ms = (v)=> v.updatedAt && v.updatedAt.toDate ? v.updatedAt.toDate().getTime() : 0;
  // Returns { priv:[...], shared:[...] }. Everyone sees their own private scripts; the admin sees all of them.
  c.list = async ()=>{
    const shared = []; const priv = [];
    (await getDocs(query(collection(db, COLL), orderBy('updatedAt', 'desc')))).forEach(d=>{ const v = d.data(); shared.push({ id: d.id, coll: COLL, name: v.name || '(untitled)', when: when(v), owner: v.owner || '' }); });
    try{
      const q = c.isAdmin ? query(collection(db, PRIV)) : query(collection(db, PRIV), where('owner', '==', (c.me.email || '').toLowerCase()));
      (await getDocs(q)).forEach(d=>{ const v = d.data(); priv.push({ id: d.id, coll: PRIV, name: v.name || '(untitled)', when: when(v), owner: v.owner || '', ms: ms(v) }); });
      priv.sort((a, b)=>b.ms - a.ms);
    }catch(e){ console.warn('Private scripts unavailable (update the Firestore rules?)', e); }
    return { priv, shared };
  };
  const collOf = (x)=> x === PRIV ? PRIV : COLL;
  c.open = async (id, coll)=>{
    coll = collOf(coll);
    if (!(await persistBeforeSwitch())) return false;
    const ds = await getDoc(doc(db, coll, id));
    if (!ds.exists()){ alert('That script no longer exists.'); return false; }
    const data = ds.data();
    c.currentDocId = id; c.currentColl = coll; c.wantPrivate = coll === PRIV; c.currentName = data.name || '';
    hooks.setText(data.text || '');
    c.savedText = hooks.getText(); rememberMeta();
    notify(`Opened “${c.currentName || '(untitled)'}”.`); changed(); return true;
  };
  c.rename = async (id, coll)=>{
    coll = collOf(coll);
    const ds = await getDoc(doc(db, coll, id)); if (!ds.exists()) return false;
    const n = prompt('Rename script to:', ds.data().name || ''); if (n === null) return false;
    const t = (n || '').trim(); if (!t){ alert('Please enter a valid name.'); return false; }
    await updateDoc(doc(db, coll, id), { name: t, updatedAt: serverTimestamp() });
    if (c.currentDocId === id && c.currentColl === coll){ c.currentName = t; rememberMeta(); changed(); }
    return true;
  };
  c.duplicate = async (id, coll)=>{
    coll = collOf(coll);
    const ds = await getDoc(doc(db, coll, id)); if (!ds.exists()) return false;
    const d = ds.data();
    await addDoc(collection(db, coll), body(`${d.name || 'Copy'} (copy)`, d.text || '', coll));      // a copy stays in the same area
    return true;
  };
  c.remove = async (id, coll)=>{
    coll = collOf(coll);
    if (!confirm('Delete this saved script?')) return false;
    await deleteDoc(doc(db, coll, id));
    if (c.currentDocId === id && c.currentColl === coll){ c.currentDocId = null; c.currentColl = COLL; c.currentName = ''; c.savedText = ''; try{ localStorage.removeItem('tp_doc_meta'); }catch{} changed(); }
    return true;
  };

  // ---------- team (admin) ----------
  c.members = async ()=>{ const snap = await getDocs(collection(db, 'members')); const rows = []; snap.forEach(d=>rows.push(d.id)); return rows.sort(); };
  c.addMembers = async (text)=>{
    const tokens = (text || '').split(/[\s,;<>()"']+/).map(t=>t.trim().toLowerCase()).filter(Boolean);
    const found = [...new Set(tokens.filter(t=>EMAIL_RE.test(t)))];
    const invalid = [...new Set(tokens.filter(t=>t.includes('@') && !EMAIL_RE.test(t)))];
    if (!found.length) return invalid.length ? `Not valid: ${invalid.join(', ')}` : 'No email addresses found in what you pasted.';
    const have = new Set(await c.members());
    const fresh = found.filter(e=>!have.has(e));
    await Promise.all(fresh.map(email=>setDoc(doc(db, 'members', email), { email, addedBy: c.me ? c.me.email : '', addedAt: serverTimestamp() })));
    const parts = [];
    if (fresh.length) parts.push(`Added ${fresh.length}: ${fresh.join(', ')}`);
    if (found.length - fresh.length) parts.push(`${found.length - fresh.length} already on the team`);
    if (invalid.length) parts.push(`not valid (skipped): ${invalid.join(', ')}`);
    return parts.join(' · ');
  };
  c.removeMember = async (email)=>{
    if (!confirm(`Remove ${email} from the team? They will no longer be able to open or save scripts.`)) return false;
    await deleteDoc(doc(db, 'members', email)); return true;
  };

  return c;
}
