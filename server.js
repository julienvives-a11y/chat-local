const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// ── Admin config ──
let adminPassword = 'jv';

// ── Bans: Map<fingerprint, { names: Set, reason, until, bannedBy }> ──
const bannedFingerprints = new Map();
// ── Also track name->fingerprint for easy unban by name ──
const nameToPrint = new Map(); // lowercase name -> fingerprint

// ── Users ──
const users = new Map(); // ws -> { name, color, isAdmin, fingerprint }
const COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#FFA07A','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#87CEEB','#90EE90'];
let colorIndex = 0;
let msgId = 0;
const messageHistory = [];

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(msg); });
}
function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
function getUserList() {
  return [...users.values()].map(u => ({ name: u.name, color: u.color, isAdmin: u.isAdmin }));
}

function checkBan(fingerprint, name) {
  // Check by fingerprint
  const byPrint = bannedFingerprints.get(fingerprint);
  if (byPrint) {
    if (byPrint.until && Date.now() > byPrint.until) {
      bannedFingerprints.delete(fingerprint);
      return null;
    }
    return byPrint;
  }
  // Check by name (for when fingerprint changes)
  const fp = nameToPrint.get(name.toLowerCase());
  if (fp) {
    const byName = bannedFingerprints.get(fp);
    if (byName) {
      if (byName.until && Date.now() > byName.until) {
        bannedFingerprints.delete(fp);
        nameToPrint.delete(name.toLowerCase());
        return null;
      }
      // Also ban this new fingerprint
      bannedFingerprints.set(fingerprint, byName);
      return byName;
    }
  }
  return null;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'join') {
        const name = (data.name || 'Anonyme').slice(0, 20).trim();
        const fingerprint = (data.fingerprint || 'unknown').slice(0, 200);
        const isAdminTry = data.isAdmin === true && data.password === adminPassword;

        // Store fingerprint->name mapping
        nameToPrint.set(name.toLowerCase(), fingerprint);

        // Check ban
        const ban = checkBan(fingerprint, name);
        if (ban) {
          const until = ban.until ? new Date(ban.until).toLocaleString('fr-FR') : 'définitivement';
          ws.send(JSON.stringify({ type: 'banned', reason: ban.reason || '', until }));
          ws.close();
          return;
        }

        // Check if pseudo is taken by a banned user
        const fp2 = nameToPrint.get(name.toLowerCase());
        if (fp2 && bannedFingerprints.has(fp2) && fp2 !== fingerprint) {
          ws.send(JSON.stringify({ type: 'banned', reason: 'Ce pseudo est banni', until: 'indéfini' }));
          ws.close();
          return;
        }

        const color = isAdminTry ? '#FFD700' : COLORS[colorIndex % COLORS.length];
        if (!isAdminTry) colorIndex++;

        users.set(ws, { name, color, isAdmin: isAdminTry, fingerprint });

        ws.send(JSON.stringify({
          type: 'welcome', color,
          isAdmin: isAdminTry,
          users: getUserList(),
          history: messageHistory
        }));

        broadcast({ type: 'user_joined', name, color, isAdmin: isAdminTry, users: getUserList() }, ws);
        broadcastAll({ type: 'system', text: `${name} a rejoint${isAdminTry ? ' 👑' : ' 👋'}` });
      }

      else if (data.type === 'message') {
        const user = users.get(ws);
        if (!user) return;
        const text = (data.text || '').slice(0, 500).trim();
        if (!text) return;
        const id = ++msgId;
        const msg = {
          type: 'message', id,
          name: user.name, color: user.color,
          isAdmin: user.isAdmin, text,
          time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        };
        messageHistory.push(msg);
        if (messageHistory.length > 200) messageHistory.shift();
        broadcastAll(msg);
      }

      else if (data.type === 'typing') {
        const user = users.get(ws);
        if (!user) return;
        broadcast({ type: 'typing', name: user.name }, ws);
      }

      else if (data.type === 'admin_cmd') {
        const user = users.get(ws);
        if (!user || !user.isAdmin) return;
        const { cmd, target, duration, reason, msgId: mId, newPassword } = data;

        if (cmd === 'delete_msg') {
          const idx = messageHistory.findIndex(m => m.id === mId);
          if (idx !== -1) messageHistory.splice(idx, 1);
          broadcastAll({ type: 'delete_msg', msgId: mId });
        }

        else if (cmd === 'kick') {
          if (target.toLowerCase() === user.name.toLowerCase()) {
            ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Tu ne peux pas te kick toi-même', ok: false }));
            return;
          }
          for (const [tws, tuser] of users.entries()) {
            if (tuser.name.toLowerCase() === target.toLowerCase()) {
              tws.send(JSON.stringify({ type: 'kicked', reason: reason || '' }));
              tws.close();
              broadcastAll({ type: 'system', text: `⚡ ${target} a été expulsé par ${user.name}` });
              break;
            }
          }
        }

        else if (cmd === 'ban') {
          if (target.toLowerCase() === user.name.toLowerCase()) {
            ws.send(JSON.stringify({ type: 'admin_notice', text: '❌ Tu ne peux pas te bannir toi-même', ok: false }));
            return;
          }
          const until = duration ? Date.now() + duration * 60000 : null;
          const banData = { reason: reason || '', until, bannedBy: user.name, names: new Set([target.toLowerCase()]) };

          // Find fingerprint of target
          let targetFP = null;
          for (const [, tuser] of users.entries()) {
            if (tuser.name.toLowerCase() === target.toLowerCase()) {
              targetFP = tuser.fingerprint;
              break;
            }
          }
          if (!targetFP) targetFP = nameToPrint.get(target.toLowerCase()) || 'unknown_' + target.toLowerCase();

          bannedFingerprints.set(targetFP, banData);
          nameToPrint.set(target.toLowerCase(), targetFP);

          // Disconnect if online
          for (const [tws, tuser] of users.entries()) {
            if (tuser.name.toLowerCase() === target.toLowerCase()) {
              const untilStr = until ? new Date(until).toLocaleString('fr-FR') : 'définitivement';
              tws.send(JSON.stringify({ type: 'banned', reason: reason || '', until: untilStr }));
              tws.close();
              break;
            }
          }
          const durStr = duration ? ` pour ${duration} min` : ' définitivement';
          broadcastAll({ type: 'system', text: `🔨 ${target} a été banni${durStr} par ${user.name}` });
          ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ ${target} banni${durStr}`, ok: true }));
        }

        else if (cmd === 'unban') {
          const fp = nameToPrint.get(target.toLowerCase());
          if (fp && bannedFingerprints.has(fp)) {
            bannedFingerprints.delete(fp);
            nameToPrint.delete(target.toLowerCase());
            broadcastAll({ type: 'system', text: `✅ ${target} a été débanni par ${user.name}` });
            ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ ${target} débanni`, ok: true }));
          } else {
            ws.send(JSON.stringify({ type: 'admin_notice', text: `❌ "${target}" n'est pas banni`, ok: false }));
          }
        }

        else if (cmd === 'clear_all') {
          messageHistory.length = 0;
          broadcastAll({ type: 'clear_all' });
        }

        else if (cmd === 'change_password') {
          if (newPassword && newPassword.length >= 2) {
            adminPassword = newPassword;
            ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ Mot de passe changé`, ok: true }));
          }
        }
      }

    } catch(e) { console.error(e.message); }
  });

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      users.delete(ws);
      broadcastAll({ type: 'system', text: `${user.name} a quitté 👋` });
      broadcast({ type: 'user_left', name: user.name, users: getUserList() });
    }
  });
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces))
    for (const i of ifaces[n])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`💬 Chat sur http://${getLocalIP()}:${PORT}`);
});
