// Web Push alerts. One browser subscription, a small creator-id list, and the service worker's
// push handler. Nothing about the library is copied to the device: the server reads its own media
// table and sends a summary, so alerts cost a subscription row and a few ids.
const KEY = 'prism.pushCreators';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function readCreators() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
function writeCreators(ids) {
  localStorage.setItem(KEY, JSON.stringify([...new Set(ids.map(String))]));
}

export function pushCreators() { return readCreators(); }
export function pushIsOn(id) { return readCreators().includes(String(id)); }

function decodeKey(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function publicKey() {
  const res = await fetch('/api/push/key', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('alerts are not available');
  const data = await res.json();
  if (!data.enabled || !data.publicKey) throw new Error('alerts are not configured on the server');
  return data.publicKey;
}

async function registration() {
  if (!('serviceWorker' in navigator)) throw new Error('this browser does not support alerts');
  await navigator.serviceWorker.register('/sw.js').catch(() => {});
  return navigator.serviceWorker.ready;
}

async function current() {
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

/** Ask the browser for permission and create (or reuse) the push subscription. */
export async function enablePush() {
  if (!pushSupported()) throw new Error('this browser does not support alerts');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'alerts are blocked in this browser' : 'alerts were not allowed');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const key = await publicKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(key) });
  }
  return sub;
}

async function save(subscription, creators) {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON ? subscription.toJSON() : subscription, creators }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'could not save alerts');
  return res.json();
}

async function update(subscription, creators) {
  const res = await fetch('/api/push/creators', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, creators }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'could not update alerts');
  return res.json();
}

/** Turn alerts on for one creator (and keep every creator this device already watches). */
export async function enableFor(id) {
  const creators = [...new Set([...readCreators(), String(id)])];
  const sub = await enablePush();
  await save(sub, creators);
  writeCreators(creators);
  return creators.length;
}

/** Turn alerts on for every creator already followed (capped by the server's 200-id list). */
export async function enableForAll(ids) {
  const creators = [...new Set((ids || []).map(String))].slice(0, 200);
  if (!creators.length) throw new Error('follow a creator first');
  const sub = await enablePush();
  await save(sub, creators);
  writeCreators(creators);
  return creators.length;
}

export async function disableFor(id) {
  const creators = readCreators().filter((x) => x !== String(id));
  const sub = await current();
  if (sub) await update(sub, creators);
  writeCreators(creators);
  if (!creators.length && sub) await sub.unsubscribe().catch(() => {});
  return creators.length;
}

/** Keep the server's list in step after a follow or unfollow. Does nothing until alerts were enabled. */
export async function syncPushCreators(ids) {
  const sub = await current().catch(() => null);
  if (!sub) return;
  const creators = [...new Set((ids || []).map(String))];
  await update(sub, creators);
  writeCreators(creators);
}

export async function disablePush() {
  const sub = await current().catch(() => null);
  if (sub) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  writeCreators([]);
}
