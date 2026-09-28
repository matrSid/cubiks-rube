(() => {
'use strict';
const App = window.CubeApp, cfg = window.FIREBASE_CONFIG;
if (!App) return;
const $ = id => document.getElementById(id);
const enabled = !!(window.firebase && cfg && cfg.apiKey && !/^YOUR_/.test(cfg.apiKey) && !/^YOUR_/.test(cfg.projectId || ''));


document.head.insertAdjacentHTML('beforeend', `<style>
[hidden]{display:none!important}
.top,.top-actions{flex-wrap:wrap}.top-actions{justify-content:flex-end}
.desc{color:var(--muted);font-size:13.5px;margin:0}
input[type=email],input[type=password]{width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.sync-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:7px;background:var(--muted)}
.sync-dot.ok{background:var(--t-ready)}.sync-dot.sync{background:var(--t-insp)}.sync-dot.off,.sync-dot.err{background:var(--danger)}
</style>`);
document.querySelector('.top-actions').insertAdjacentHTML('afterbegin',
  '<button class="btn" id="btnAccount" type="button"><span id="accLabel">Sign in</span><span class="sync-dot" id="syncDot" hidden></span></button>');
document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlgAccount" aria-labelledby="dlgAccountTitle">
  <div class="dlg-head"><h2 id="dlgAccountTitle">Account</h2><button class="lnk" type="button" data-close>Close</button></div>
  <div class="dlg-body">
    <p class="desc" id="accOff" hidden>Cloud sync isn't set up yet. Fill in firebase-config.js to turn it on.</p>
    <div class="dlg-body" id="accOut" style="padding:0">
      <p class="desc">Sign in to sync your solves and settings across devices. Solves already on this device are added to your account, and if your account already has solves, both sets are combined.</p>
      <button class="btn primary" id="btnGoogle" type="button">Continue with Google</button>
      <hr class="sep">
      <form id="accForm" class="dlg-body" style="padding:0" novalidate>
        <input type="email" id="accEmail" placeholder="Email" autocomplete="email" aria-label="Email">
        <input type="password" id="accPass" placeholder="Password" autocomplete="current-password" aria-label="Password">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn primary" type="submit">Sign in</button>
          <button class="btn" id="btnCreate" type="button">Create account</button>
          <button class="lnk" id="btnReset" type="button">Forgot password?</button>
        </div>
      </form>
      <p class="inline-msg" id="accMsg" role="status"></p>
    </div>
    <div class="dlg-body" id="accIn" style="padding:0" hidden>
      <p style="margin:0">Signed in as <b id="accWho"></b></p>
      <p class="inline-msg" id="accSync" role="status"></p>
      <p class="desc">Your solves sync automatically. Import / export still works as a backup. Signing out removes solves from this device; they stay in your account.</p>
    </div>
  </div>
  <div class="dlg-foot"><button class="btn danger spacer" id="btnSignOut" type="button" hidden>Sign out</button><button class="btn" type="button" data-close>Done</button></div>
</dialog>`);
const dlg = $('dlgAccount');
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
$('btnAccount').addEventListener('click', () => { paint(); dlg.showModal(); });

/* ---------- state & helpers ---------- */
let auth = null, db = null;
const cloud = { user:null, col:null, sets:null, mirror:new Map(), ready:false, setsOk:false, pending:false, error:'', unsubs:[] };
const sig = s => s.ms + '|' + s.pen + '|' + s.ts + '|' + (s.scr || '');
const toDoc = s => ({ ms:s.ms, pen:s.pen, ts:s.ts, scr:s.scr || '' });
const fromDoc = d => {
  const x = d.data(), o = { id:d.id, ms:x.ms, pen:x.pen, ts:x.ts, scr:typeof x.scr === 'string' ? x.scr : '' };
  return Number.isFinite(o.ms) && o.ms > 0 && (o.pen === 0 || o.pen === 2000 || o.pen === -1) && Number.isFinite(o.ts) ? o : null;
};
const sameList = (a, b) => a.length === b.length && a.every((s, i) => s.id === b[i].id && sig(s) === sig(b[i]));
const fail = e => { cloud.error = e && e.code === 'permission-denied' ? 'Access denied. Publish firestore.rules in the Firebase console.' : ((e && e.message) || 'Sync error'); paint(); };

function commit(col, ops){          
  const jobs = [];
  for (let i = 0; i < ops.length; i += 400){
    const b = db.batch();
    ops.slice(i, i + 400).forEach(([k, v]) => k === 'set' ? b.set(col.doc(v.id), toDoc(v)) : b.delete(col.doc(v)));
    jobs.push(b.commit());
  }
  return Promise.all(jobs);
}
function push(){                       
  const solves = App.getSolves(), ops = [], seen = new Set();
  for (const s of solves){ seen.add(s.id); if (cloud.mirror.get(s.id) !== sig(s)) ops.push(['set', s]); }
  for (const id of cloud.mirror.keys()) if (!seen.has(id)) ops.push(['del', id]);
  if (!ops.length) return;
  ops.forEach(([k, v]) => k === 'set' ? cloud.mirror.set(v.id, sig(v)) : cloud.mirror.delete(v));
  cloud.pending = true; paint();
  commit(cloud.col, ops).catch(fail);
}


function onSolves(snap){
  cloud.pending = snap.metadata.hasPendingWrites; cloud.error = '';
  const server = !snap.metadata.fromCache, first = !cloud.ready;
  const guest = first ? App.readGuest() : [];
  if (first && guest.length && !server){ paint(); return; }     // wait for the server before merging, so nothing is duplicated
  if (!first && !snap.docChanges().length){ paint(); return; }
  const list = [], mirror = new Map();
  snap.docs.forEach(d => { const o = fromDoc(d); if (o){ list.push(o); mirror.set(o.id, sig(o)); } });
  const up = [];
  if (first){
    const keys = new Set(list.map(s => s.ts + '|' + s.ms));
    guest.forEach(g => {
      const k = g.ts + '|' + g.ms;
      if (!mirror.has(g.id) && !keys.has(k)){ keys.add(k); up.push(g); list.push(g); mirror.set(g.id, sig(g)); }
    });
    cloud.ready = true;
  }
  cloud.mirror = mirror;
  list.sort((a, b) => a.ts - b.ts);
  if (!sameList(App.getSolves(), list)) App.setSolves(list);
  if (first && guest.length){
    commit(cloud.col, up.map(g => ['set', g])).then(() => App.clearGuest()).catch(fail);
    if (up.length) App.toast(`Added ${up.length} solve${up.length === 1 ? '' : 's'} from this device to your account`);
  }
  paint();
}
function onSets(snap){
  if (!snap.exists){
    if (!snap.metadata.fromCache){ cloud.setsOk = true; cloud.sets.set(App.getSettings()).catch(() => {}); }
    return;
  }
  cloud.setsOk = true;
  if (snap.metadata.hasPendingWrites) return;
  const cur = App.getSettings(), d = snap.data(), next = { ...cur };
  Object.keys(cur).forEach(k => { if (typeof d[k] === typeof cur[k]) next[k] = d[k]; });
  if (['live','seconds','hidden'].indexOf(next.live) < 0) next.live = cur.live;
  if (JSON.stringify(next) !== JSON.stringify(cur)) App.setSettings(next);
}

function start(user){
  stop(true);
  const u = db.collection('users').doc(user.uid);
  Object.assign(cloud, { user, col:u.collection('solves'), sets:u.collection('meta').doc('settings'), ready:false, setsOk:false, error:'' });
  cloud.unsubs = [
    cloud.col.onSnapshot({ includeMetadataChanges:true }, onSolves, fail),
    cloud.sets.onSnapshot({ includeMetadataChanges:true }, onSets, () => {})
  ];
  paint();
}
function stop(quiet){
  const was = !!cloud.user;
  cloud.unsubs.forEach(f => f());
  Object.assign(cloud, { user:null, col:null, sets:null, mirror:new Map(), ready:false, setsOk:false, pending:false, error:'', unsubs:[] });
  if (was && !quiet) App.setSolves(App.readGuest());   // back to this device's own (signed-out) solves
  paint();
}

window.CloudSync = {
  onSolvesChanged(){ if (!(cloud.user && cloud.ready)) return false; push(); return true; },
  onSettingsChanged(s){ if (cloud.user && cloud.setsOk) cloud.sets.set(s).catch(() => {}); }
};


const ERR = {
  'auth/invalid-credential':'Wrong email or password.', 'auth/wrong-password':'Wrong email or password.', 'auth/user-not-found':'Wrong email or password.',
  'auth/invalid-email':'Enter a valid email address.', 'auth/missing-password':'Enter your password.',
  'auth/email-already-in-use':'That email already has an account. Try signing in.', 'auth/weak-password':'Use a password of at least 6 characters.',
  'auth/too-many-requests':'Too many attempts. Try again later.', 'auth/network-request-failed':'No connection. Try again when you are online.',
  'auth/popup-closed-by-user':'Sign-in was cancelled.', 'auth/cancelled-popup-request':'Sign-in was cancelled.',
  'auth/operation-not-allowed':'This sign-in method is not enabled in the Firebase console.',
  'auth/unauthorized-domain':"Add this site's domain under Authentication > Settings > Authorized domains."
};
function msg(t, err){ const m = $('accMsg'); m.textContent = t || ''; m.className = 'inline-msg' + (err ? ' err' : ''); }
const run = p => { msg(''); return p.catch(e => msg(ERR[e.code] || e.message, true)); };

function paint(){
  const u = cloud.user;
  $('accOff').hidden = enabled; $('accOut').hidden = !enabled || !!u; $('accIn').hidden = !u; $('btnSignOut').hidden = !u;
  $('accLabel').textContent = u ? String(u.displayName || u.email || 'Account').split(/[ @]/)[0] : 'Sign in';
  let s = 'ok', t = 'All solves are synced.';
  if (cloud.error){ s = 'err'; t = cloud.error; }
  else if (!navigator.onLine){ s = 'off'; t = 'Offline. Changes will sync when you reconnect.'; }
  else if (!cloud.ready || cloud.pending){ s = 'sync'; t = 'Syncing…'; }
  $('syncDot').hidden = !u; $('syncDot').className = 'sync-dot ' + s;
  if (u){ $('accWho').textContent = u.email || u.displayName || 'your account'; $('accSync').textContent = t; }
}
window.addEventListener('online', paint);
window.addEventListener('offline', paint);
paint();
if (!enabled) return;


try{
  firebase.initializeApp(cfg);
  auth = firebase.auth(); db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs:true }).catch(() => {});   // offline cache
}catch(e){ console.error(e); $('accOff').textContent = 'Firebase could not start. Check firebase-config.js.'; $('accOff').hidden = false; $('accOut').hidden = true; return; }

$('btnGoogle').addEventListener('click', () => run(
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')
      return auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
    throw e;
  })));
$('accForm').addEventListener('submit', e => { e.preventDefault(); run(auth.signInWithEmailAndPassword($('accEmail').value.trim(), $('accPass').value)); });
$('btnCreate').addEventListener('click', () => run(auth.createUserWithEmailAndPassword($('accEmail').value.trim(), $('accPass').value)));
$('btnReset').addEventListener('click', () => {
  const em = $('accEmail').value.trim();
  if (!em){ msg('Enter your email above first.', true); return; }
  run(auth.sendPasswordResetEmail(em).then(() => msg('Password reset email sent.')));
});
$('btnSignOut').addEventListener('click', () => auth.signOut());
auth.getRedirectResult().catch(e => msg(ERR[e.code] || e.message, true));
auth.onAuthStateChanged(user => { if (user) start(user); else stop(false); });
})();
