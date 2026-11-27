const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 100;

const server = http.createServer((req, res) => {
  const cleanUrl = (req.url || '/').split('?')[0];
  if (cleanUrl === '/' || cleanUrl === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('تعذر تحميل ملف index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

const players = new Map();
const usedSlots = new Set();
const birdMarketListings = []; // { listingId, sellerId, sellerName, sellerSlot, price, bird }

function allocateSlot() {
  for (let slot = 1; slot <= MAX_PLAYERS; slot++) {
    if (!usedSlots.has(slot)) {
      usedSlots.add(slot);
      const col = (slot - 1) % 10;
      const row = Math.floor((slot - 1) / 10);
      const roofX = (col - 4.5) * 140;
      const roofZ = (row - 4.5) * 140;
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

function sendToPlayer(playerId, payload) {
  const p = players.get(playerId);
  if (p && p.ws.readyState === WebSocket.OPEN) {
    p.ws.send(JSON.stringify(payload));
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
let nextListingId = 1;

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
    doorOpen: false,
    flyingCount: 0,
    pigeons: [],
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
        doorOpen: other.doorOpen,
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
    leaderboard: getLeaderboard(),
    marketListings: birdMarketListings
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
      doorOpen: playerData.doorOpen,
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
    if (!cur || !msg || typeof msg.type !== 'string') return;

    if (msg.type === 'STATE_UPDATE') {
      if (typeof msg.x === 'number' && Number.isFinite(msg.x)) cur.x = msg.x;
      if (typeof msg.y === 'number' && Number.isFinite(msg.y)) cur.y = msg.y;
      if (typeof msg.z === 'number' && Number.isFinite(msg.z)) cur.z = msg.z;
      if (typeof msg.yaw === 'number' && Number.isFinite(msg.yaw)) cur.yaw = msg.yaw;
      if (typeof msg.skin === 'string') cur.skin = msg.skin;
      if (typeof msg.name === 'string' && msg.name.trim()) cur.name = msg.name.trim().slice(0, 20);
      if (typeof msg.doorOpen === 'boolean') cur.doorOpen = msg.doorOpen;
      if (typeof msg.coins === 'number' && Number.isFinite(msg.coins) && msg.coins >= 0 && msg.coins <= 10000000) {
        cur.coins = Math.floor(msg.coins);
      }
      if (typeof msg.flyingCount === 'number' && Number.isFinite(msg.flyingCount)) {
        cur.flyingCount = Math.max(0, Math.floor(msg.flyingCount));
      }
      if (Array.isArray(msg.pigeons)) cur.pigeons = msg.pigeons.slice(0, 45);

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
        doorOpen: cur.doorOpen,
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
    } else if (msg.type === 'VISIT_REQUEST' && msg.targetId) {
      const target = players.get(msg.targetId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
          type: 'VISIT_REQUEST',
          fromId: cur.id,
          fromName: cur.name
        }));
      }
    } else if (msg.type === 'VISIT_RESPONSE' && msg.targetId) {
      const target = players.get(msg.targetId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
          type: 'VISIT_RESPONSE',
          fromId: cur.id,
          accepted: !!msg.accepted,
          roofX: cur.roofX,
          roofZ: cur.roofZ,
          slot: cur.slot,
          ownerName: cur.name
        }));
      }
    } else if (msg.type === 'KICK_VISITOR' && msg.targetId) {
      const target = players.get(msg.targetId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({ type: 'KICKED_FROM_ROOF' }));
      }
    } else if (msg.type === 'MARKET_LIST_BIRD' && msg.bird) {
      const price = Math.max(10, Math.min(50000, Math.floor(Number(msg.price) || 100)));
      const listing = {
        listingId: 'lst_' + nextListingId++,
        sellerId: cur.id,
        sellerName: cur.name,
        sellerSlot: cur.slot,
        price,
        bird: {
          uid: String(msg.bird.uid || ('b_' + Date.now())),
          breedId: String(msg.bird.breedId || 'zajil'),
          breedName: String(msg.bird.breedName || 'زاجل'),
          customName: String(msg.bird.customName || '').slice(0, 18),
          isChick: !!msg.bird.isChick,
          growth: Number(msg.bird.growth) || 100,
          isTamed: !!msg.bird.isTamed,
          speed: Number(msg.bird.speed) || 12.0
        }
      };
      birdMarketListings.push(listing);
      broadcast({ type: 'MARKET_SYNC', marketListings: birdMarketListings });
      sendToPlayer(cur.id, { type: 'MARKET_SYNC', marketListings: birdMarketListings });
    } else if (msg.type === 'MARKET_BUY_BIRD' && msg.listingId) {
      const idx = birdMarketListings.findIndex((item) => item.listingId === msg.listingId);
      if (idx === -1) {
        sendToPlayer(cur.id, { type: 'MARKET_ERROR', message: 'هذا الطير تم بيعه أو سحبه.' });
        return;
      }
      const item = birdMarketListings[idx];
      if (item.sellerId === cur.id) {
        sendToPlayer(cur.id, { type: 'MARKET_ERROR', message: 'هذا الطير معروض من قبلك.' });
        return;
      }
      if (cur.coins < item.price) {
        sendToPlayer(cur.id, { type: 'MARKET_ERROR', message: 'رصيدك غير كافٍ لشراء هذا الطير.' });
        return;
      }

      cur.coins -= item.price;
      birdMarketListings.splice(idx, 1);

      const seller = players.get(item.sellerId);
      if (seller) {
        seller.coins += item.price;
        sendToPlayer(seller.id, {
          type: 'MARKET_BIRD_SOLD',
          soldBirdUid: item.bird.uid,
          price: item.price,
          buyerName: cur.name,
          newCoins: seller.coins
        });
      }

      sendToPlayer(cur.id, {
        type: 'MARKET_BIRD_PURCHASED',
        bird: item.bird,
        price: item.price,
        newCoins: cur.coins
      });

      broadcast({ type: 'MARKET_SYNC', marketListings: birdMarketListings });
      sendToPlayer(cur.id, { type: 'MARKET_SYNC', marketListings: birdMarketListings });
    }
  });

  ws.on('close', () => {
    const leaving = players.get(id);
    if (leaving) {
      usedSlots.delete(leaving.slot);
      players.delete(id);
      for (let i = birdMarketListings.length - 1; i >= 0; i--) {
        if (birdMarketListings[i].sellerId === id) {
          birdMarketListings.splice(i, 1);
        }
      }
      broadcast({
        type: 'PLAYER_LEFT',
        id,
        onlineCount: players.size,
        leaderboard: getLeaderboard(),
        marketListings: birdMarketListings
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

server.listen(PORT, () => {
  console.log(`Pigeon Kingdom Online Server running on port ${PORT}`);
});
