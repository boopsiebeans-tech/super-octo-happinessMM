const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 100;

const wss = new WebSocket.Server({ port: PORT });

const players = new Map();
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

function serializePlayer(p) {
  return {
    id: p.id,
    slot: p.slot,
    roofX: p.roofX,
    roofZ: p.roofZ,
    name: p.name,
    skin: p.skin,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    coins: p.coins,
    flyingCount: p.flyingCount,
    doorOpen: p.doorOpen,
    pigeons: p.pigeons
  };
}

function broadcast(payload, excludeId = null) {
  const raw = JSON.stringify(payload);
  for (const [id, p] of players.entries()) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(raw);
    }
  }
}

function sendToPlayer(targetId, payload) {
  const target = players.get(targetId);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify(payload));
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
    doorOpen: false,
    lastLaunchRewardAt: 0,
    pigeons: [],
    ws
  };

  players.set(id, playerData);

  const snapshot = [];
  for (const [, other] of players.entries()) {
    if (other.id !== id) {
      snapshot.push(serializePlayer(other));
    }
  }

  ws.send(JSON.stringify({
    type: 'WELCOME',
    self: serializePlayer(playerData),
    onlineCount: players.size,
    maxPlayers: MAX_PLAYERS,
    players: snapshot,
    leaderboard: getLeaderboard()
  }));

  broadcast({
    type: 'PLAYER_JOINED',
    onlineCount: players.size,
    player: serializePlayer(playerData),
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
    if (!cur || !msg || typeof msg.type !== 'string') return;

    if (msg.type === 'STATE_UPDATE') {
      if (typeof msg.x === 'number' && Number.isFinite(msg.x)) cur.x = msg.x;
      if (typeof msg.y === 'number' && Number.isFinite(msg.y)) cur.y = msg.y;
      if (typeof msg.z === 'number' && Number.isFinite(msg.z)) cur.z = msg.z;
      if (typeof msg.yaw === 'number' && Number.isFinite(msg.yaw)) cur.yaw = msg.yaw;
      if (typeof msg.skin === 'string') cur.skin = msg.skin.slice(0, 24);
      if (typeof msg.name === 'string' && msg.name.trim()) cur.name = msg.name.trim().slice(0, 20);
      if (typeof msg.coins === 'number' && Number.isFinite(msg.coins) && msg.coins >= 0) {
        cur.coins = Math.min(9999999, Math.floor(msg.coins));
      }
      if (typeof msg.flyingCount === 'number' && Number.isFinite(msg.flyingCount)) {
        cur.flyingCount = Math.max(0, Math.min(50, Math.floor(msg.flyingCount)));
      }
      if (typeof msg.doorOpen === 'boolean') cur.doorOpen = msg.doorOpen;
      if (Array.isArray(msg.pigeons)) {
        cur.pigeons = msg.pigeons.slice(0, 30).map((b) => ({
          breedId: String(b.breedId || 'zajil').slice(0, 16),
          name: String(b.name || '').slice(0, 18),
          flying: !!b.flying,
          isChick: !!b.isChick,
          x: Number.isFinite(b.x) ? b.x : cur.roofX,
          y: Number.isFinite(b.y) ? b.y : 12.0,
          z: Number.isFinite(b.z) ? b.z : cur.roofZ,
          yaw: Number.isFinite(b.yaw) ? b.yaw : 0
        }));
      }

      broadcast({
        type: 'PLAYER_STATE',
        player: serializePlayer(cur)
      }, id);
    } else if (msg.type === 'CLAIM_LAUNCH_REWARD') {
      const now = Date.now();
      if (now - cur.lastLaunchRewardAt >= 20000 && cur.flyingCount > 0) {
        cur.lastLaunchRewardAt = now;
        cur.coins += 25;
        sendToPlayer(id, {
          type: 'LAUNCH_REWARD_APPROVED',
          coins: cur.coins,
          reward: 25
        });
      }
    } else if (msg.type === 'VISIT_REQUEST' && msg.targetId) {
      const target = players.get(msg.targetId);
      if (target && target.id !== id) {
        sendToPlayer(target.id, {
          type: 'VISIT_REQUEST',
          fromId: cur.id,
          fromName: cur.name,
          fromSlot: cur.slot
        });
      }
    } else if (msg.type === 'VISIT_RESPONSE' && msg.visitorId) {
      const visitor = players.get(msg.visitorId);
      if (visitor) {
        if (msg.accepted) {
          sendToPlayer(visitor.id, {
            type: 'VISIT_ACCEPTED',
            hostId: cur.id,
            hostName: cur.name,
            hostSlot: cur.slot,
            roofX: cur.roofX,
            roofZ: cur.roofZ
          });
        } else {
          sendToPlayer(visitor.id, {
            type: 'VISIT_DECLINED',
            hostName: cur.name
          });
        }
      }
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

console.log(`Pigeon Kingdom Online Server running on port ${PORT}`);
