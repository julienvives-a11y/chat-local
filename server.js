const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// ── Admin config (in-memory, persists while server runs) ──
let adminPassword = 'jv';

// ── Banned users (name -> { until: timestamp|null, reason })
const banned = new Map();

// ── Users & state ──
const users = new Map(); // ws -> { name, color, isAdmin, id }
const COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#FFA07A','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#87CEEB','#90EE90'];
let colorIndex = 0;
let msgIdCounter = 0;
const messageHistory = []; // { id, type, name, color, text, time, isAdmin }

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
function isBanned(name) {
  const b = banned.get(name.toLowerCase());
  if (!b) return false;
  if (b.until && Date.now() > b.until) { banned.delete(name.toLowerCase()); return false; }
  return b;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      // ── JOIN ──
      if (data.type === 'join') {
        const name = (data.name || 'Anonyme').slice(0, 20).trim();

        // Check ban
        const ban = isBanned(name);
        if (ban) {
          const until = ban.until ? new Date(ban.until).toLocaleString('fr-FR') : 'définitivement';
          ws.send(JSON.stringify({ type: 'banned', reason: ban.reason || '', until }));
          ws.close();
          return;
        }

        // Admin check
        const isAdmin = data.isAdmin === true && data.password === adminPassword;

        const color = isAdmin ? '#FFD700' : COLORS[colorIndex % COLORS.length];
        if (!isAdmin) colorIndex++;

        users.set(ws, { name, color, isAdmin });

        ws.send(JSON.stringify({
          type: 'welcome',
          color,
          isAdmin,
          users: getUserList(),
          history: messageHistory
        }));

        broadcast({ type: 'user_joined', name, color, isAdmin, users: getUserList() }, ws);
        broadcastAll({ type: 'system', text: `${name} a rejoint${isAdmin ? ' 👑' : ' 👋'}` });
      }

      // ── MESSAGE ──
      else if (data.type === 'message') {
        const user = users.get(ws);
        if (!user) return;
        const text = (data.text || '').slice(0, 500).trim();
        if (!text) return;
        const id = ++msgIdCounter;
        const msg = {
          type: 'message', id,
          name: user.name, color: user.color,
          isAdmin: user.isAdmin,
          text,
          time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        };
        messageHistory.push(msg);
        if (messageHistory.length > 200) messageHistory.shift();
        broadcastAll(msg);
      }

      // ── TYPING ──
      else if (data.type === 'typing') {
        const user = users.get(ws);
        if (!user) return;
        broadcast({ type: 'typing', name: user.name }, ws);
      }

      // ── ADMIN COMMANDS ──
      else if (data.type === 'admin_cmd') {
        const user = users.get(ws);
        if (!user || !user.isAdmin) return;

        const { cmd, target, duration, reason, msgId, newPassword } = data;

        if (cmd === 'delete_msg') {
          const idx = messageHistory.findIndex(m => m.id === msgId);
          if (idx !== -1) messageHistory.splice(idx, 1);
          broadcastAll({ type: 'delete_msg', msgId });
        }

        else if (cmd === 'kick') {
          // Find target ws
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
          const until = duration ? Date.now() + duration * 60000 : null;
          banned.set(target.toLowerCase(), { until, reason: reason || '' });
          for (const [tws, tuser] of users.entries()) {
            if (tuser.name.toLowerCase() === target.toLowerCase()) {
              const untilStr = until ? new Date(until).toLocaleString('fr-FR') : 'définitivement';
              tws.send(JSON.stringify({ type: 'banned', reason: reason || '', until: untilStr }));
              tws.close();
              break;
            }
          }
          broadcastAll({ type: 'system', text: `🔨 ${target} a été banni${duration ? ` pour ${duration} min` : ' définitivement'} par ${user.name}` });
        }

        else if (cmd === 'unban') {
          banned.delete(target.toLowerCase());
          broadcastAll({ type: 'system', text: `✅ ${target} a été débanni par ${user.name}` });
        }

        else if (cmd === 'clear_all') {
          messageHistory.length = 0;
          broadcastAll({ type: 'clear_all' });
        }

        else if (cmd === 'change_password') {
          if (newPassword && newPassword.length >= 2) {
            adminPassword = newPassword;
            ws.send(JSON.stringify({ type: 'admin_notice', text: `✅ Mot de passe changé en "${newPassword}"` }));
          }
        }
      }

    } catch (e) { console.error(e.message); }
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
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n💬 Chat démarré sur http://${getLocalIP()}:${PORT}\n`);
});
