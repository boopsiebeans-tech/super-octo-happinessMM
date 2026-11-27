const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 100;

const wss = new WebSocket.Server({ port: PORT });

// Slots 1..100 each with a dedicated rooftop center on a 10x10 grid (120m spacing)
const players = new Map(); // id -> player state
const usedSlots = new Set();

function allocateSlot() {
  for (let slot = 1; slot <= MAX_PLAYERS; slot++) {
    if (!usedSlots.has(slot)) {
      usedSlots.add(slot);
      const col = (slot - 1) % 10;
      const row = Math.floor((slot - 1) / 10);
      const roofX = (col - 4.5) * 120;
      const roofZ = (row - 4.5) * 120;
      return { slot, roofX, roofZ };
    }
  }
  return null;
}

function broadcast(payload, excludeId = null) {
  const raw = JSON.stringify(payload);
  for (const [id, p] of players.entries()) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(raw);
    }
  }
}

function getLeaderboard() {
  return Array.from(players.values())
    .map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      coins: p.coins,
      flyingCount: p.flyingCount
    }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 15);
}

let nextId = 1;

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'SERVER_FULL', message: 'السيرفر ممتلئ (100/100 لاعب).' }));
    ws.close();
    return;
  }

  const alloc = allocateSlot();
  if (!alloc) {
    ws.close();
    return;
  }

  const id = 'p_' + nextId++;
  const playerData = {
    id,
    slot: alloc.slot,
    roofX: alloc.roofX,
    roofZ: alloc.roofZ,
    name: `مطيرجي #${alloc.slot}`,
    skin: 'baghdadi',
    x: alloc.roofX + 1.2,
    y: 12.0,
    z: alloc.roofZ + 5.2,
    yaw: 0,
    coins: 250,
    flyingCount: 0,
    pigeons: [],
    ws
  };

  players.set(id, playerData);

  // Send initial welcome + existing players snapshot
  const snapshot = [];
  for (const [, other] of players.entries()) {
    if (other.id !== id) {
      snapshot.push({
        id: other.id,
        slot: other.slot,
        roofX: other.roofX,
        roofZ: other.roofZ,
        name: other.name,
        skin: other.skin,
        x: other.x,
        y: other.y,
        z: other.z,
        yaw: other.yaw,
        coins: other.coins,
        flyingCount: other.flyingCount,
        pigeons: other.pigeons
      });
    }
  }

  ws.send(JSON.stringify({
    type: 'WELCOME',
    self: {
      id: playerData.id,
      slot: playerData.slot,
      roofX: playerData.roofX,
      roofZ: playerData.roofZ,
      name: playerData.name
    },
    onlineCount: players.size,
    maxPlayers: MAX_PLAYERS,
    players: snapshot,
    leaderboard: getLeaderboard()
  }));

  broadcast({
    type: 'PLAYER_JOINED',
    onlineCount: players.size,
    player: {
      id: playerData.id,
      slot: playerData.slot,
      roofX: playerData.roofX,
      roofZ: playerData.roofZ,
      name: playerData.name,
      skin: playerData.skin,
      x: playerData.x,
      y: playerData.y,
      z: playerData.z,
      yaw: playerData.yaw,
      coins: playerData.coins,
      flyingCount: playerData.flyingCount,
      pigeons: playerData.pigeons
    },
    leaderboard: getLeaderboard()
  }, id);

  ws.on('message', (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch (e) {
      return;
    }

    const cur = players.get(id);
    if (!cur) return;

    if (msg.type === 'STATE_UPDATE') {
      if (typeof msg.x === 'number') cur.x = msg.x;
      if (typeof msg.y === 'number') cur.y = msg.y;
      if (typeof msg.z === 'number') cur.z = msg.z;
      if (typeof msg.yaw === 'number') cur.yaw = msg.yaw;
      if (typeof msg.skin === 'string') cur.skin = msg.skin;
      if (typeof msg.name === 'string' && msg.name.trim()) cur.name = msg.name.trim().slice(0, 20);
      if (typeof msg.coins === 'number') cur.coins = Math.floor(msg.coins);
      if (typeof msg.flyingCount === 'number') cur.flyingCount = msg.flyingCount;
      if (Array.isArray(msg.pigeons)) cur.pigeons = msg.pigeons.slice(0, 35);

      broadcast({
        type: 'PLAYER_STATE',
        id: cur.id,
        slot: cur.slot,
        name: cur.name,
        skin: cur.skin,
        x: cur.x,
        y: cur.y,
        z: cur.z,
        yaw: cur.yaw,
        coins: cur.coins,
        flyingCount: cur.flyingCount,
        pigeons: cur.pigeons
      }, id);
    } else if (msg.type === 'WHISTLE_SIGNAL') {
      broadcast({
        type: 'WHISTLE_SIGNAL',
        fromName: cur.name,
        slot: cur.slot,
        action: msg.action || 'launch'
      }, id);
    } else if (msg.type === 'CHAT_MSG' && typeof msg.text === 'string' && msg.text.trim()) {
      broadcast({
        type: 'CHAT_MSG',
        fromName: cur.name,
        slot: cur.slot,
        text: msg.text.trim().slice(0, 90)
      });
    }
  });

  ws.on('close', () => {
    const leaving = players.get(id);
    if (leaving) {
      usedSlots.delete(leaving.slot);
      players.delete(id);
      broadcast({
        type: 'PLAYER_LEFT',
        id,
        onlineCount: players.size,
        leaderboard: getLeaderboard()
      });
    }
  });
});

setInterval(() => {
  broadcast({
    type: 'LEADERBOARD_SYNC',
    onlineCount: players.size,
    leaderboard: getLeaderboard()
  });
}, 5000);

console.log(`Pigeon Kingdom Online Server (Max ${MAX_PLAYERS} players) running on ws://localhost:${PORT}`);
