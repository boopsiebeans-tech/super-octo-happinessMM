const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 100;

const wss = new WebSocket.Server({ port: PORT });

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
      coins: Math.max(0, Math.floor(p.coins)),
      flyingCount: Math.max(0, Math.floor(p.flyingCount || 0))
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
    coopOpen: false,
    pigeons: [],
    lastLaunchRewardAt: 0,
    ws
  };

  players.set(id, playerData);

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
        coopOpen: other.coopOpen,
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
      name: playerData.name,
      coins: playerData.coins
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
      coopOpen: playerData.coopOpen,
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
      if (typeof msg.x === 'number' && Number.isFinite(msg.x)) cur.x = msg.x;
      if (typeof msg.y === 'number' && Number.isFinite(msg.y)) cur.y = msg.y;
      if (typeof msg.z === 'number' && Number.isFinite(msg.z)) cur.z = msg.z;
      if (typeof msg.yaw === 'number' && Number.isFinite(msg.yaw)) cur.yaw = msg.yaw;
      if (typeof msg.skin === 'string') cur.skin = msg.skin.slice(0, 24);
      if (typeof msg.name === 'string' && msg.name.trim()) cur.name = msg.name.trim().slice(0, 20);
      if (typeof msg.coopOpen === 'boolean') cur.coopOpen = msg.coopOpen;
      if (typeof msg.flyingCount === 'number' && Number.isFinite(msg.flyingCount)) {
        cur.flyingCount = Math.max(0, Math.min(50, Math.floor(msg.flyingCount)));
      }
      if (typeof msg.coins === 'number' && Number.isFinite(msg.coins)) {
        // Prevent negative or absurd jump exploits without valid action
        const cleanCoins = Math.max(0, Math.floor(msg.coins));
        if (cleanCoins <= cur.coins + 2500) {
          cur.coins = cleanCoins;
        }
      }
      if (Array.isArray(msg.pigeons)) {
        cur.pigeons = msg.pigeons.slice(0, 35).map((p) => ({
          uid: String(p.uid || ''),
          breedId: String(p.breedId || 'zajil'),
          customName: String(p.customName || '').slice(0, 18),
          isChick: !!p.isChick,
          growth: typeof p.growth === 'number' ? Math.max(0, Math.min(100, p.growth)) : 100,
          isTamed: !!p.isTamed,
          state: String(p.state || 'WALK'),
          x: typeof p.x === 'number' ? p.x : cur.roofX,
          y: typeof p.y === 'number' ? p.y : 12.0,
          z: typeof p.z === 'number' ? p.z : cur.roofZ,
          yaw: typeof p.yaw === 'number' ? p.yaw : 0
        }));
      }

      broadcast({
        type: 'PLAYER_STATE',
        id: cur.id,
        slot: cur.slot,
        roofX: cur.roofX,
        roofZ: cur.roofZ,
        name: cur.name,
        skin: cur.skin,
        x: cur.x,
        y: cur.y,
        z: cur.z,
        yaw: cur.yaw,
        coins: cur.coins,
        flyingCount: cur.flyingCount,
        coopOpen: cur.coopOpen,
        pigeons: cur.pigeons
      }, id);
    } else if (msg.type === 'CLAIM_LAUNCH_REWARD') {
      const now = Date.now();
      const launchedCount = typeof msg.launchedCount === 'number' ? Math.floor(msg.launchedCount) : 0;
      if (launchedCount > 0 && now - cur.lastLaunchRewardAt >= 4000) {
        cur.lastLaunchRewardAt = now;
        cur.coins += 100;
        ws.send(JSON.stringify({
          type: 'REWARD_GRANTED',
          coins: cur.coins,
          amount: 100
        }));
      }
    } else if (msg.type === 'VISIT_REQUEST' && typeof msg.targetId === 'string') {
      const target = players.get(msg.targetId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
          type: 'VISIT_REQUEST',
          visitorId: cur.id,
          visitorName: cur.name,
          visitorSlot: cur.slot
        }));
      }
    } else if (msg.type === 'VISIT_RESPONSE' && typeof msg.visitorId === 'string') {
      const visitor = players.get(msg.visitorId);
      if (visitor && visitor.ws.readyState === WebSocket.OPEN) {
        const accepted = !!msg.accepted;
        visitor.ws.send(JSON.stringify({
          type: 'VISIT_RESULT',
          targetId: cur.id,
          targetName: cur.name,
          targetSlot: cur.slot,
          roofX: cur.roofX,
          roofZ: cur.roofZ,
          accepted
        }));
      }
    } else if (msg.type === 'WHISTLE_SIGNAL') {
      broadcast({
        type: 'WHISTLE_SIGNAL',
        fromId: cur.id,
        fromName: cur.name,
        slot: cur.slot,
        action: msg.action || 'launch'
      }, id);
    } else if (msg.type === 'CHAT_MSG' && typeof msg.text === 'string' && msg.text.trim()) {
      broadcast({
        type: 'CHAT_MSG',
        fromId: cur.id,
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
