const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve the chat page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Store connected users
const users = new Map(); // ws -> { name, color }
const COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#F0B27A'];
let colorIndex = 0;

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function getUserList() {
  return [...users.values()].map(u => ({ name: u.name, color: u.color }));
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`Nouvelle connexion depuis ${ip}`);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'join') {
        const name = (data.name || 'Anonyme').slice(0, 20).trim();
        const color = COLORS[colorIndex % COLORS.length];
        colorIndex++;
        users.set(ws, { name, color, ip });

        // Send welcome to new user
        ws.send(JSON.stringify({
          type: 'welcome',
          color,
          users: getUserList(),
          history: messageHistory
        }));

        // Notify others
        broadcast({ type: 'user_joined', name, color, users: getUserList() }, ws);
        broadcastAll({ type: 'system', text: `${name} a rejoint le chat 👋` });
        console.log(`${name} a rejoint`);
      }

      else if (data.type === 'message') {
        const user = users.get(ws);
        if (!user) return;
        const text = (data.text || '').slice(0, 500).trim();
        if (!text) return;

        const msg = {
          type: 'message',
          name: user.name,
          color: user.color,
          text,
          time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        };

        messageHistory.push(msg);
        if (messageHistory.length > 100) messageHistory.shift();

        broadcastAll(msg);
      }

      else if (data.type === 'typing') {
        const user = users.get(ws);
        if (!user) return;
        broadcast({ type: 'typing', name: user.name }, ws);
      }
    } catch (e) {
      console.error('Message invalide:', e.message);
    }
  });

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      users.delete(ws);
      broadcastAll({ type: 'system', text: `${user.name} a quitté le chat 👋` });
      broadcast({ type: 'user_left', name: user.name, users: getUserList() });
      console.log(`${user.name} a quitté`);
    }
  });
});

// Message history (in-memory)
const messageHistory = [];

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║       💬 Chat Local démarré !          ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}        ║`);
  console.log(`║  Réseau:  http://${ip}:${PORT}       ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log('║  Partage l\'adresse Réseau avec tes     ║');
  console.log('║  amis connectés au même WiFi !         ║');
  console.log('╚════════════════════════════════════════╝\n');
});
