// שכבת הנתונים: Firebase (אמיתי) או מצב הדגמה מקומי. לשתיהן אותו ממשק.
import { CONFIG } from "./config.js";

const LS_USER = "hasera.user";
const COLLS = ["highlights", "comments", "tags", "videoEdits", "users"];

export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
  return d;
}
export async function userKey(phone) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hasera:" + normPhone(phone)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
function loadLocalUser() {
  try { return JSON.parse(localStorage.getItem(LS_USER)) || null; } catch { return null; }
}
function saveLocalUser(u) {
  try { u ? localStorage.setItem(LS_USER, JSON.stringify(u)) : localStorage.removeItem(LS_USER); } catch {}
}

/* ---------- base ---------- */
class BaseStore {
  constructor() {
    this.data = Object.fromEntries(COLLS.map((c) => [c, new Map()]));
    this.user = loadLocalUser(); // {key, name}
    this.isAdmin = false;
    this.adminEmail = null;
    this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach((fn) => fn()); }
  list(coll, videoId) {
    const all = [...this.data[coll].values()];
    return videoId ? all.filter((x) => x.videoId === videoId) : all;
  }
  canEdit(item) { return !!item && (this.isAdmin || (this.user && item.author === this.user.key)); }
}

/* ---------- demo (localStorage) ---------- */
class DemoStore extends BaseStore {
  constructor() { super(); this.mode = "demo"; }
  async init() {
    try {
      const raw = JSON.parse(localStorage.getItem("hasera.demo") || "{}");
      for (const c of COLLS) for (const [id, v] of Object.entries(raw[c] || {})) this.data[c].set(id, { id, ...v });
    } catch {}
    this.isAdmin = localStorage.getItem("hasera.demoAdmin") === "1";
    this.emit();
  }
  persist() {
    const out = {};
    for (const c of COLLS) out[c] = Object.fromEntries([...this.data[c]].map(([id, v]) => [id, v]));
    try { localStorage.setItem("hasera.demo", JSON.stringify(out)); } catch {}
  }
  async login(name, phone) {
    const key = await userKey(phone);
    const existing = this.data.users.get(key);
    if (!existing) this.data.users.set(key, { id: key, name, uids: ["demo"], createdAt: Date.now() });
    this.user = { key, name: existing?.name || name };
    saveLocalUser(this.user); this.persist(); this.emit();
    return this.user;
  }
  async logout() { this.user = null; this.isAdmin = false; saveLocalUser(null); localStorage.removeItem("hasera.demoAdmin"); this.emit(); }
  async adminLogin() { this.isAdmin = true; this.adminEmail = "demo@example.com"; localStorage.setItem("hasera.demoAdmin", "1"); this.emit(); return { ok: true }; }
  async add(coll, data) {
    const id = Math.random().toString(36).slice(2, 12);
    this.data[coll].set(id, { id, ...data, author: this.user?.key, authorName: this.user?.name, createdAt: Date.now() });
    this.persist(); this.emit(); return id;
  }
  async update(coll, id, patch) {
    const cur = this.data[coll].get(id) || { id };
    this.data[coll].set(id, { ...cur, ...patch, id });
    this.persist(); this.emit();
  }
  async remove(coll, id) { this.data[coll].delete(id); this.persist(); this.emit(); }
}

/* ---------- Firebase ---------- */
const FB = "https://www.gstatic.com/firebasejs/12.19.0/";
class FirebaseStore extends BaseStore {
  constructor() { super(); this.mode = "firebase"; }
  async init() {
    const [{ initializeApp }, A, F] = await Promise.all([
      import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js"),
    ]);
    this.A = A; this.F = F;
    const app = initializeApp(CONFIG.firebase);
    this.auth = A.getAuth(app);
    this.db = F.getFirestore(app);
    if (location.hostname === "localhost" && new URLSearchParams(location.search).has("emu")) {
      A.connectAuthEmulator(this.auth, "http://127.0.0.1:9099", { disableWarnings: true });
      F.connectFirestoreEmulator(this.db, "127.0.0.1", 8089);
    }
    await new Promise((res) => {
      const off = A.onAuthStateChanged(this.auth, async (u) => {
        if (!u) { try { await A.signInAnonymously(this.auth); } catch (e) { console.error(e); res(); } return; }
        off(); res();
      });
    });
    for (const c of COLLS) {
      F.onSnapshot(F.collection(this.db, c), (snap) => {
        const m = new Map();
        snap.forEach((d) => m.set(d.id, { id: d.id, ...d.data() }));
        this.data[c] = m;
        if (c === "users") this.ensureLinked();
        this.emit();
      }, (e) => console.error(c, e));
    }
    await this.checkAdmin();
  }
  get uid() { return this.auth?.currentUser?.uid; }
  // המכשיר זוכר את המשתמש; אם ה-uid של המכשיר לא רשום אצלו, מוסיפים אותו
  async ensureLinked() {
    if (!this.user || !this.uid || this._linking) return;
    const u = this.data.users.get(this.user.key);
    if (!u) return;
    if ((u.uids || []).includes(this.uid)) return;
    this._linking = true;
    try { await this.F.updateDoc(this.F.doc(this.db, "users", this.user.key), { uids: this.F.arrayUnion(this.uid) }); }
    catch (e) { console.error(e); } finally { this._linking = false; }
  }
  async checkAdmin() {
    const email = this.auth.currentUser?.email;
    this.adminEmail = email || null;
    this.isAdmin = false;
    if (!email) return;
    try { this.isAdmin = (await this.F.getDoc(this.F.doc(this.db, "admins", email))).exists(); } catch { this.isAdmin = false; }
    this.emit();
  }
  async login(name, phone) {
    const { F } = this;
    const key = await userKey(phone);
    const ref = F.doc(this.db, "users", key);
    const snap = await F.getDoc(ref);
    if (snap.exists()) {
      await F.updateDoc(ref, { uids: F.arrayUnion(this.uid) });
      this.user = { key, name: snap.data().name };
    } else {
      await F.setDoc(ref, { name, uids: [this.uid], createdAt: F.serverTimestamp() });
      this.user = { key, name };
    }
    saveLocalUser(this.user); this.emit();
    return this.user;
  }
  async logout() {
    this.user = null; saveLocalUser(null);
    if (this.auth.currentUser?.email) { await this.A.signOut(this.auth); await this.A.signInAnonymously(this.auth); }
    this.isAdmin = false; this.adminEmail = null; this.emit();
  }
  // כניסת מנהל: חשבון גוגל. אם עוד אין מנהל, הראשון שנכנס הופך למנהל.
  async adminLogin() {
    const { A, F } = this;
    const provider = new A.GoogleAuthProvider();
    try {
      if (this.auth.currentUser?.isAnonymous) await A.linkWithPopup(this.auth.currentUser, provider);
      else if (!this.auth.currentUser?.email) await A.signInWithPopup(this.auth, provider);
    } catch (e) {
      if (e.code === "auth/credential-already-in-use") {
        // חשבון הגוגל כבר מחובר ממכשיר אחר: נכנסים איתו בלי חלון נוסף
        const cred = A.GoogleAuthProvider.credentialFromError(e);
        if (cred) await A.signInWithCredential(this.auth, cred);
        else await A.signInWithPopup(this.auth, provider);
      } else if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
        return { ok: false, reason: "cancelled" };
      } else throw e;
    }
    await this.ensureLinked();
    const email = this.auth.currentUser.email;
    await this.checkAdmin();
    if (this.isAdmin) return { ok: true };
    const lock = await F.getDoc(F.doc(this.db, "config", "adminLock"));
    if (!lock.exists()) {
      const b = F.writeBatch(this.db);
      b.set(F.doc(this.db, "admins", email), { at: F.serverTimestamp() });
      b.set(F.doc(this.db, "config", "adminLock"), { at: F.serverTimestamp() });
      await b.commit();
      await this.checkAdmin();
      return { ok: this.isAdmin, claimed: true };
    }
    return { ok: false, reason: "not-admin", email };
  }
  async add(coll, data) {
    const { F } = this;
    const ref = await F.addDoc(F.collection(this.db, coll), {
      ...data, author: this.user.key, authorName: this.user.name, createdAt: F.serverTimestamp(),
    });
    return ref.id;
  }
  async update(coll, id, patch) {
    const { F } = this;
    if (coll === "videoEdits") await F.setDoc(F.doc(this.db, coll, id), { ...patch, at: F.serverTimestamp() }, { merge: true });
    else await F.updateDoc(F.doc(this.db, coll, id), patch);
  }
  async remove(coll, id) { await this.F.deleteDoc(this.F.doc(this.db, coll, id)); }
}

export function createStore() {
  return CONFIG.firebase ? new FirebaseStore() : new DemoStore();
}
export function tsMillis(x) {
  if (!x) return Date.now();
  if (typeof x === "number") return x;
  if (x.toMillis) return x.toMillis();
  return Date.now();
}
