const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json({ limit: '15mb' }));

// ── Admin accounts ──
const ADMINS = {
  'juju':  { password: 'jv',                role: 'owner' },
  'jerry': { password: 'qwertyazerty123321', role: 'coowner' }
};

const bannedFingerprints = new Map();
const nameToPrint = new Map();
const users = new Map(); // ws -> { name, color, role, fingerprint, ghost: bool, ghostTimer }
// ghost = user closed tab but still "online" for 15 min

const COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#FFA07A','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#87CEEB','#90EE90'];
let colorIndex = 0;
let msgId = 0;
const messageHistory = [];
const GHOST_TIMEOUT = 15 * 60 * 1000; // 15 minutes

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function broadcast(data, exclude = null) {
  const m = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(m); });
}
function broadcastAll(data) {
  const m = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(m); });
}
function getUserList() {
  // Include ghost users
  const live = [...users.values()].map(u => ({ name: u.name, color: u.color, role: u.role, ghost: u.ghost || false }));
  ghostUsers.forEach(g => {
    if (!live.find(u => u.name === g.name)) live.push({ name: g.name, color: g.color, role: g.role, ghost: true });
  });
  return live;
}
function serializeMsg(m) {
  const reactions = {};
  if (m.reactions) for (const [e, s] of Object.entries(m.reactions)) reactions[e] = [...s];
  return { ...m, reactions };
}
function checkBan(fingerprint, name) {
  const b = bannedFingerprints.get(fingerprint);
  if (b) {
    if (b.until && Date.now() > b.until) { bannedFingerprints.delete(fingerprint); return null; }
    return b;
  }
  const fp = nameToPrint.get(name.toLowerCase());
  if (fp) {
    const b2 = bannedFingerprints.get(fp);
    if (b2) {
      if (b2.until && Date.now() > b2.until) { bannedFingerprints.delete(fp); nameToPrint.delete(name.toLowerCase()); return null; }
      bannedFingerprints.set(fingerprint, b2);
      return b2;
    }
  }
  return null;
}
function isStaff(role) { return role === 'owner' || role === 'coowner'; }

// ── Ghost users (disconnected but still "online") ──
// Map: name -> { name, color, role, fingerprint, timer }
const ghostUsers = new Map();

function addGhost(user) {
  // Cancel existing ghost timer for this name
  const existing = ghostUsers.get(user.name);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    ghostUsers.delete(user.name);
    broadcastAll({ type: 'user_left', name: user.name, users: getUserList() });
    broadcastAll({ type: 'system', text: `${user.name} a quitté 👋` });
  }, GHOST_TIMEOUT);
  ghostUsers.set(user.name, { ...user, timer });
  // Notify everyone user is now ghost (still online but inactive)
  broadcastAll({ type: 'user_ghost', name: user.name, users: getUserList() });
}

function removeGhost(name) {
  const g = ghostUsers.get(name);
  if (g) { clearTimeout(g.timer); ghostUsers.delete(name); }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      // JOIN
      if (data.type === 'join') {
        const name = (data.name || 'Anonyme').slice(0, 20).trim();
        const fp   = (data.fingerprint || 'unknown').slice(0, 200);

        // Admin check
        let role = 'user';
        const adminEntry = ADMINS[name.toLowerCase()];
        if (adminEntry) {
          if (data.password === adminEntry.password) role = adminEntry.role;
          else { ws.send(JSON.stringify({ type: 'wrong_password', role: adminEntry.role })); ws.close(); return; }
        }

        nameToPrint.set(name.toLowerCase(), fp);

        // Ban check
        const ban = checkBan(fp, name);
        if (ban) {
          ws.send(JSON.stringify({ type: 'banned', reason: ban.reason || '', until: ban.until ? new Date(ban.until).toLocaleString('fr-FR') : 'définitivement' }));
          ws.close(); return;
        }
        const fp2 = nameToPrint.get(name.toLowerCase());
        if (fp2 && bannedFingerprints.has(fp2) && fp2 !== fp) {
          ws.send(JSON.stringify({ type: 'banned', reason: 'Ce pseudo est banni', until: 'indéfini' }));
          ws.close(); return;
        }

        // If reconnecting as ghost, restore
        removeGhost(name);

        const color = role === 'owner' ? '#FFD700' : role === 'coowner' ? '#00d4ff' : COLORS[colorIndex++ % COLORS.length];
        users.set(ws, { name, color, role, fingerprint: fp });

        ws.send(JSON.stringify({ type: 'welcome', color, role, users: getUserList(), history: messageHistory.map(serializeMsg) }));
        broadcast({ type: 'user_joined', name, color, role, users: getUserList() }, ws);
        const tag = role === 'owner' ? ' 👑' : role === 'coowner' ? ' 🛡️' : ' 👋';
        broadcastAll({ type: 'system', text: `${name} a rejoint${tag}` });
      }

      // MESSAGE
      else if (data.type === 'message') {
        const user = users.get(ws); if (!user) return;
        const text = (data.text || '').slice(0, 500).trim(); if (!text) return;
        const id = ++msgId;
        const mentions = (text.match(/@(\w+)/g) || []).map(m => m.slice(1).toLowerCase());
        const replyTo = data.replyTo || null;
        const msg = { type: 'message', id, name: user.name, color: user.color, role: user.role, text, time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), replyTo, mentions, reactions: {} };
        messageHistory.push(msg); if (messageHistory.length > 200) messageHistory.shift();
        mentions.forEach(mn => {
          for (const [tws, tu] of users.entries()) {
            if (tu.name.toLowerCase() === mn && tws !== ws)
              tws.send(JSON.stringify({ type: 'mention', fromName: user.name, fromColor: user.color, text, msgId: id }));
          }
        });
        broadcastAll(serializeMsg(msg));
      }

      // IMAGE
      else if (data.type === 'image') {
        const user = users.get(ws); if (!user) return;
        const { dataUrl, fileName } = data;
        if (!dataUrl || !dataUrl.startsWith('data:image/')) return;
        if (dataUrl.length > 5 * 1024 * 1024) { ws.send(JSON.stringify({ type: 'error', text: 'Image trop lourde (max ~4MB)' })); return; }
        const id = ++msgId;
        const msg = { type: 'image', id, name: user.name, color: user.color, role: user.role, dataUrl, fileName: fileName || 'image', time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), reactions: {} };
        messageHistory.push(msg); if (messageHistory.length > 200) messageHistory.shift();
        broadcastAll(serializeMsg(msg));
      }

      // VOICE MESSAGE
      else if (data.type === 'voice') {
        const user = users.get(ws); if (!user) return;
        const { audioData, duration } = data;
        if (!audioData) return;
        if (audioData.length > 10 * 1024 * 1024) { ws.send(JSON.stringify({ type: 'error', text: 'Message vocal trop long' })); return; }
        const id = ++msgId;
        const msg = { type: 'voice', id, name: user.name, color: user.color, role: user.role, audioData, duration: duration || 0, time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), reactions: {} };
        messageHistory.push(msg); if (messageHistory.length > 200) messageHistory.shift();
        broadcastAll(serializeMsg(msg));
      }

      // TYPING
      else if (data.type === 'typing') {
        const user = users.get(ws); if (!user) return;
        broadcast({ type: 'typing', name: user.name }, ws);
      }

      // REACTION
      else if (data.type === 'reaction') {
        const user = users.get(ws); if (!user) return;
        const { msgId: mId, emoji } = data;
        if (!['👍','❤️','😂','😮','😢','🔥'].includes(emoji)) return;
        const msg = messageHistory.find(m => m.id === mId); if (!msg) return;
        if (!msg.reactions[emoji]) msg.reactions[emoji] = new Set();
        if (msg.reactions[emoji].has(user.name)) { msg.reactions[emoji].delete(user.name); if (!msg.reactions[emoji].size) delete msg.reactions[emoji]; }
        else msg.reactions[emoji].add(user.name);
        const reactions = {};
        for (const [e, s] of Object.entries(msg.reactions)) reactions[e] = [...s];
        broadcastAll({ type: 'reaction_update', msgId: mId, reactions });
      }

      // ADMIN
      else if (data.type === 'admin_cmd') {
        const user = users.get(ws); if (!user || !isStaff(user.role)) return;
        const { cmd, target, duration, reason, msgId: mId, newPassword } = data;

        if (cmd === 'delete_msg') {
          const idx = messageHistory.findIndex(m => m.id === mId);
          if (idx !== -1) messageHistory.splice(idx, 1);
          broadcastAll({ type: 'delete_msg', msgId: mId });
        }
        else if (cmd === 'kick') {
          if (target.toLowerCase() === user.name.toLowerCase()) { ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Tu ne peux pas te kick', ok: false })); return; }
          for (const [tws, tu] of users.entries()) {
            if (tu.name.toLowerCase() === target.toLowerCase()) {
              if (user.role === 'coowner' && tu.role === 'owner') { ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Tu ne peux pas kick le Owner', ok: false })); return; }
              tws.send(JSON.stringify({ type: 'kicked', reason: reason || '' })); tws.close();
              broadcastAll({ type: 'system', text: `⚡ ${target} expulsé par ${user.name}` }); break;
            }
          }
        }
        else if (cmd === 'ban') {
          // Both owner and coowner can ban now
          if (target.toLowerCase() === user.name.toLowerCase()) { ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Tu ne peux pas te bannir', ok: false })); return; }
          if (user.role === 'coowner') {
            // Coowner can't ban owner
            for (const [, tu] of users.entries()) if (tu.name.toLowerCase() === target.toLowerCase() && tu.role === 'owner') { ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Tu ne peux pas bannir le Owner', ok: false })); return; }
          }
          const until = duration ? Date.now() + duration * 60000 : null;
          const banData = { reason: reason || '', until, bannedBy: user.name };
          let targetFP = null;
          for (const [, tu] of users.entries()) if (tu.name.toLowerCase() === target.toLowerCase()) { targetFP = tu.fingerprint; break; }
          if (!targetFP) targetFP = nameToPrint.get(target.toLowerCase()) || 'unk_' + target.toLowerCase();
          bannedFingerprints.set(targetFP, banData);
          nameToPrint.set(target.toLowerCase(), targetFP);
          for (const [tws, tu] of users.entries()) {
            if (tu.name.toLowerCase() === target.toLowerCase()) {
              tws.send(JSON.stringify({ type: 'banned', reason: reason || '', until: until ? new Date(until).toLocaleString('fr-FR') : 'définitivement' }));
              tws.close(); break;
            }
          }
          const durStr = duration ? ` pour ${duration} min` : ' définitivement';
          broadcastAll({ type: 'system', text: `🔨 ${target} banni${durStr} par ${user.name}` });
          ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ ${target} banni${durStr}`, ok: true }));
        }
        else if (cmd === 'unban') {
          const fp = nameToPrint.get(target.toLowerCase());
          if (fp && bannedFingerprints.has(fp)) {
            bannedFingerprints.delete(fp); nameToPrint.delete(target.toLowerCase());
            broadcastAll({ type: 'system', text: `✅ ${target} débanni par ${user.name}` });
            ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ ${target} débanni`, ok: true }));
          } else ws.send(JSON.stringify({ type: 'admin_notice', text: `❌ "${target}" n'est pas banni`, ok: false }));
        }
        else if (cmd === 'clear_all') {
          messageHistory.length = 0; broadcastAll({ type: 'clear_all' });
        }
        else if (cmd === 'change_password') {
          if (user.role !== 'owner') { ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Seul le Owner peut changer les mots de passe', ok: false })); return; }
          if (newPassword && newPassword.length >= 2) {
            ADMINS[data.target_admin || 'juju'].password = newPassword;
            ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ Mot de passe changé`, ok: true }));
          }
        }
      }

    } catch (e) { console.error(e.message); }
  });

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      users.delete(ws);
      // Don't remove from user list yet — ghost for 15 min
      addGhost(user);
    }
  });
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces)) for (const i of ifaces[n]) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`💬 Chat sur http://${getLocalIP()}:${PORT}`));
