const admin = require('firebase-admin');

// ── Firebase init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://nova-chat-and-communities-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ── Shared context passed to every bot's runtimeCode ──
function buildCtx(db, bot, stopSelf) {
  const listeners = [];

  async function sendMsg(channelId, content) {
    if (!channelId || !content) return;
    const id = 'msg' + Math.random().toString(36).substring(2, 14);
    await db.ref('state/messages/' + channelId + '/' + id).set({
      id, uid: bot.uid, name: bot.name,
      color: bot.avatarColor || '#7c3aed',
      avatarUrl: bot.avatarUrl || '',
      content, ts: Date.now(),
      reactions: [], pinned: false, edited: false,
    });
  }

  function listenChannel(channelId, callback) {
    let ready = false;
    const ref = db.ref('state/messages/' + channelId);
    const handler = ref.on('child_added', snap => {
      if (!ready) return;
      if (!snap.exists()) return;
      const msg = snap.val();
      if (!msg || !msg.content) return;
      if ((msg.uid || '').startsWith('bot_')) return;
      callback(msg);
    });
    setTimeout(() => { ready = true; }, 1500);
    const unsub = () => ref.off('child_added', handler);
    listeners.push(unsub);
    return unsub;
  }

  async function dbGet(path) {
    const snap = await db.ref(path).get();
    return snap.exists() ? snap.val() : null;
  }

  async function dbSet(path, value) {
    await db.ref(path).set(value);
  }

  function dbListen(path, callback) {
    const ref = db.ref(path);
    const handler = ref.on('value', snap => callback(snap.exists() ? snap.val() : null));
    const unsub = () => ref.off('value', handler);
    listeners.push(unsub);
    return unsub;
  }

  async function setPresence(customStatus) {
    await db.ref('presence/' + bot.uid).set({
      uid: bot.uid, name: bot.name,
      avatarUrl: bot.avatarUrl || '',
      avatarColor: bot.avatarColor || '#7c3aed',
      status: 'online', customStatus: customStatus || '',
      isBot: true, ts: Date.now(),
    });
  }

  function log(level, msg) {
    const p = '[' + bot.uid + '] ';
    if (level === 'error') console.error(p + msg);
    else if (level === 'warn') console.warn(p + msg);
    else console.log(p + msg);
  }

  function pickItem(items) {
    if (!items || !items.length) return null;
    const total = items.reduce((s, it) => s + (it.weight || 60), 0);
    let rand = Math.random() * total;
    for (const it of items) { rand -= (it.weight || 60); if (rand <= 0) return it; }
    return items[items.length - 1];
  }

  async function saveCapture(userId, item, num, userName) {
    await db.ref('botdata/captures/' + userId + '/' + bot.uid + '/' + item.id).set({
      itemId: item.id, name: item.name, icon: item.icon || '',
      rarity: item.rarity, description: item.description || '',
      imageUrl: item.imageUrl || '', num: num || 0,
      caughtAt: Date.now(), userName: userName || '',
    });
  }

  async function sendCollection(channelId, userId, userName) {
    const RARITY_ICONS = { common:'○', uncommon:'◉', rare:'◈', epic:'◆', legendary:'★' };
    const RARITY_NAMES = { common:'Común', uncommon:'Poco común', rare:'Raro', epic:'Épico', legendary:'Legendario' };
    const data = await dbGet('botdata/captures/' + userId + '/' + bot.uid);
    if (!data) { await sendMsg(channelId, (userName||'Tú') + ' no tiene ningún elemento todavía.'); return; }
    const col = Object.values(data);
    col.sort((a, b) => (a.num||0) - (b.num||0));
    let reply = '📦 Colección de **' + (userName||'usuario') + '** — ' + col.length + ' elemento(s):\n';
    ['legendary','epic','rare','uncommon','common'].forEach(r => {
      const its = col.filter(x => x.rarity === r); if (!its.length) return;
      reply += '\n' + RARITY_ICONS[r] + ' **' + (RARITY_NAMES[r]||r) + ':** ' + its.map(x => (x.icon||'') + ' ' + x.name).join(', ') + '\n';
    });
    await sendMsg(channelId, reply.trim());
  }

  function scheduleInterval(minutes, callback) {
    let timer;
    function next() {
      const ms = minutes * 60000;
      const jitter = ms * 0.15;
      const delay = ms + (Math.random() * jitter * 2 - jitter);
      timer = setTimeout(() => { callback(); next(); }, delay);
    }
    next();
    const cancel = () => clearTimeout(timer);
    listeners.push(cancel);
    return cancel;
  }

  return {
    bot, sendMsg, listenChannel, dbGet, dbSet, dbListen,
    setPresence, log, pickItem, saveCapture, sendCollection,
    scheduleInterval,
    stop: () => stopSelf(),
    _cleanup: () => listeners.forEach(fn => { try { fn(); } catch(e) {} }),
  };
}

// ── Active instances ──
const active = {};

function startBot(botId, bot) {
  if (active[botId]) return;
  if (!bot.runtimeCode) { console.log('[' + botId + '] Sin runtimeCode, omitiendo.'); return; }
  console.log('[' + botId + '] Iniciando "' + bot.name + '" (' + bot.type + ')...');
  const ctx = buildCtx(db, bot, () => stopBot(botId));
  try {
    new Function('ctx', bot.runtimeCode)(ctx);
    active[botId] = { ctx };
    console.log('[' + botId + '] OK');
  } catch(e) {
    console.error('[' + botId + '] Error runtimeCode:', e.message);
  }
}

function stopBot(botId) {
  const inst = active[botId]; if (!inst) return;
  try { inst.ctx._cleanup(); } catch(e) {}
  delete active[botId];
  db.ref('presence/' + botId).remove().catch(() => {});
  console.log('[' + botId + '] Detenido.');
}

// ── Watch botdata/bots ──
db.ref('botdata/bots').on('child_added',   snap => { const b=snap.val(); if(b?.uid && b?.runtimeCode) startBot(b.uid, b); });
db.ref('botdata/bots').on('child_changed', snap => { const b=snap.val(); if(!b?.uid) return; stopBot(b.uid); if(b.runtimeCode) startBot(b.uid, b); });
db.ref('botdata/bots').on('child_removed', snap => { const b=snap.val(); if(b?.uid) stopBot(b.uid); });

console.log('Nova Bots runner iniciado.');
process.on('SIGTERM', () => { Object.keys(active).forEach(stopBot); process.exit(0); });
process.on('SIGINT',  () => { Object.keys(active).forEach(stopBot); process.exit(0); });
