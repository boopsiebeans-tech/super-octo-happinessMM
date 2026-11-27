const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// بيانات السوق والطيور مع تفاصيل كل طير (السوق ثابت كما هو)
const MARKET_BIRDS = [
  {
    id: "baladi",
    name: "حمام بلدي",
    price: 250,
    speed: 3.4,
    altitude: 165,
    agility: 0.92,
    color: "#8d99ae",
    accent: "#2b2d42",
    description: "طير صبور وقوي التحمل، سريع الاستجابة لأوامر النزول والإقلاع ومناسب للبداية."
  },
  {
    id: "qalbe",
    name: "قلبي",
    price: 500,
    speed: 4.0,
    altitude: 195,
    agility: 0.96,
    color: "#f4a261",
    accent: "#e76f51",
    description: "يتميز بدوران رشيق في الجو وثبات عالٍ عند الحوم فوق السطح."
  },
  {
    id: "shami",
    name: "شامي أصيل",
    price: 900,
    speed: 4.6,
    altitude: 225,
    agility: 1.02,
    color: "#e9ecef",
    accent: "#495057",
    description: "تحليق مرتفع وانسيابي مع سرعة ممتازة ومسار طيران واسع."
  },
  {
    id: "baghdadi",
    name: "بغدادي فاخر",
    price: 1500,
    speed: 5.3,
    altitude: 260,
    agility: 1.08,
    color: "#a8dadc",
    accent: "#1d3557",
    description: "من أسرع الطيور وأكثرها رشاقة، يجمع بين الارتفاع العالي والانسيابية الدقيقة."
  }
];

const MARKET_MAP = new Map(MARKET_BIRDS.map((b) => [b.id, b]));

// حالة العالم واللاعبين في الذاكرة
const players = new Map(); // playerId -> playerState
const visitRequests = new Map(); // requestId -> { id, fromId, toId, createdAt }
const chatMessages = []; // آخر الرسائل

function createInitialBirds(ownerId) {
  return [
    {
      uid: `${ownerId}_b1`,
      speciesId: "baladi",
      name: "حمام بلدي",
      x: 260,
      y: 360,
      z: 0, // الارتفاع عن الأرض (0 = على الأرض، > 0 = في الجو)
      vx: 0,
      vy: 0,
      vz: 0,
      angle: 0,
      state: "ground", // "ground" | "flying"
      lastActionAt: 0
    },
    {
      uid: `${ownerId}_b2`,
      speciesId: "qalbe",
      name: "قلبي",
      x: 320,
      y: 375,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      angle: Math.PI * 0.35,
      state: "ground",
      lastActionAt: 0
    }
  ];
}

function createPlayer(id, name) {
  return {
    id,
    name: name || `لاعب_${id.slice(0, 4)}`,
    balance: 1000,
    x: 450,
    y: 390,
    vx: 0,
    vy: 0,
    facing: 1,
    viewingOwnerId: id, // السطح الذي يشاهده اللاعب حالياً (سطحه أو سطح مضيف)
    birds: createInitialBirds(id),
    lastTakeoffRewardAt: 0,
    lastLandRewardAt: 0,
    ws: null
  };
}

// أدوات WebSocket خفيفة ومستقرة بدون مكتبات خارجية
function encodeWsFrame(dataStr) {
  const payload = Buffer.from(dataStr, "utf8");
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const isFinal = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    const totalLen = headerLen + maskLen + payloadLen;
    if (offset + totalLen > buffer.length) break;

    if (opcode === 0x8) {
      // Close frame
      return { messages, remaining: Buffer.alloc(0), closed: true };
    }

    if (opcode === 0x9) {
      // Ping -> Pong
      const pong = Buffer.alloc(2);
      pong[0] = 0x8a;
      pong[1] = 0;
      messages.push({ __pong: pong });
      offset += totalLen;
      continue;
    }

    if (isFinal && opcode === 0x1 && isMasked) {
      const maskKey = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const dataStart = offset + headerLen + 4;
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = buffer[dataStart + i] ^ maskKey[i % 4];
      }
      try {
        messages.push(JSON.parse(unmasked.toString("utf8")));
      } catch (_) {}
    }

    offset += totalLen;
  }

  return { messages, remaining: buffer.subarray(offset), closed: false };
}

function sendJson(player, obj) {
  if (!player || !player.ws || player.ws.destroyed) return;
  try {
    player.ws.write(encodeWsFrame(JSON.stringify(obj)));
  } catch (_) {}
}

function broadcast(obj) {
  const encoded = encodeWsFrame(JSON.stringify(obj));
  for (const p of players.values()) {
    if (p.ws && !p.ws.destroyed) {
      try {
        p.ws.write(encoded);
      } catch (_) {}
    }
  }
}

// فيزياء الطيور وتحديث حالة الجو والأرض
const ROOFTOP_BOUNDS = {
  minX: 110,
  maxX: 790,
  minY: 295,
  maxY: 455,
  cage: { x: 120, y: 245, w: 135, h: 95 }
};

function stepPhysics() {
  const now = Date.now();

  for (const owner of players.values()) {
    for (const bird of owner.birds) {
      const spec = MARKET_MAP.get(bird.speciesId) || MARKET_BIRDS[0];

      if (bird.state === "flying") {
        // صعود سلس نحو ارتفاع التحليق ثم دوران طبيعي في الجو
        const targetAlt = spec.altitude;
        if (bird.z < targetAlt) {
          bird.z = Math.min(targetAlt, bird.z + 2.4);
        } else {
          bird.z = targetAlt + Math.sin(now * 0.004 + bird.x * 0.02) * 10;
        }

        bird.angle += 0.022 * spec.agility;
        const centerX = 450;
        const centerY = 355;
        const orbitRadiusX = 250;
        const orbitRadiusY = 75;

        const targetX = centerX + Math.cos(bird.angle) * orbitRadiusX;
        const targetY = centerY + Math.sin(bird.angle) * orbitRadiusY;

        bird.vx = (targetX - bird.x) * 0.04 * (spec.speed / 3.5);
        bird.vy = (targetY - bird.y) * 0.04 * (spec.speed / 3.5);

        bird.x += bird.vx;
        bird.y += bird.vy;

        // حدود السماء حول السطح
        bird.x = Math.max(70, Math.min(830, bird.x));
        bird.y = Math.max(150, Math.min(440, bird.y));
      } else {
        // على الأرض: هبوط سلس إذا كان z > 0 وحركة هادئة داخل حدود السطح
        if (bird.z > 0) {
          bird.z = Math.max(0, bird.z - 4.2);
        }

        bird.x += bird.vx;
        bird.y += bird.vy;
        bird.vx *= 0.85;
        bird.vy *= 0.85;

        if (bird.x < ROOFTOP_BOUNDS.minX) {
          bird.x = ROOFTOP_BOUNDS.minX;
          bird.vx = Math.abs(bird.vx) * 0.5;
        } else if (bird.x > ROOFTOP_BOUNDS.maxX) {
          bird.x = ROOFTOP_BOUNDS.maxX;
          bird.vx = -Math.abs(bird.vx) * 0.5;
        }

        if (bird.y < ROOFTOP_BOUNDS.minY) {
          bird.y = ROOFTOP_BOUNDS.minY;
          bird.vy = Math.abs(bird.vy) * 0.5;
        } else if (bird.y > ROOFTOP_BOUNDS.maxY) {
          bird.y = ROOFTOP_BOUNDS.maxY;
          bird.vy = -Math.abs(bird.vy) * 0.5;
        }
      }
    }
  }
}

function getPublicWorldSnapshot() {
  const list = [];
  for (const p of players.values()) {
    list.push({
      id: p.id,
      name: p.name,
      balance: p.balance,
      x: p.x,
      y: p.y,
      facing: p.facing,
      viewingOwnerId: p.viewingOwnerId,
      birds: p.birds.map((b) => ({
        uid: b.uid,
        speciesId: b.speciesId,
        name: b.name,
        x: Math.round(b.x * 10) / 10,
        y: Math.round(b.y * 10) / 10,
        z: Math.round(b.z * 10) / 10,
        state: b.state,
        // الاسم يظهر فقط على الأرض ويختفي عند الطيران
        showName: b.state === "ground" && b.z < 2
      }))
    });
  }

  return {
    type: "world_state",
    players: list,
    market: MARKET_BIRDS,
    chat: chatMessages.slice(-30)
  };
}

// معالجة أوامر اللاعبين بشكل آمن ومنع الكلجات
function handleClientMessage(player, msg) {
  if (!msg || typeof msg !== "object") return;
  const now = Date.now();

  switch (msg.type) {
    case "set_name": {
      if (typeof msg.name === "string") {
        const clean = msg.name.trim().slice(0, 18);
        if (clean) player.name = clean;
      }
      sendJson(player, { type: "self_info", id: player.id, name: player.name, balance: player.balance });
      break;
    }

    case "move": {
      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const mag = Math.hypot(dx, dy);
      const speed = 4.5;

      if (mag > 0.01) {
        const nx = dx / mag;
        const ny = dy / mag;
        player.vx = nx * speed;
        player.vy = ny * speed;
        if (Math.abs(nx) > 0.08) {
          player.facing = nx >= 0 ? 1 : -1;
        }
        player.x = Math.max(ROOFTOP_BOUNDS.minX, Math.min(ROOFTOP_BOUNDS.maxX, player.x + player.vx));
        player.y = Math.max(ROOFTOP_BOUNDS.minY, Math.min(ROOFTOP_BOUNDS.maxY, player.y + player.vy));
      } else {
        player.vx = 0;
        player.vy = 0;
      }
      break;
    }

    // إقلاع أو نزول آمن بدون كلج الفلوس:
    // مكافأة صغيرة مرة واحدة فقط عند تغيير الحالة من الأرض للجو أو العكس، مع مهلة 4 ثوانٍ ومنع التكرار العشوائي
    case "toggle_flight": {
      const targetOwner = players.get(player.viewingOwnerId) || player;
      const targetBirds = targetOwner.birds;
      if (!Array.isArray(targetBirds) || targetBirds.length === 0) break;

      const anyOnGround = targetBirds.some((b) => b.state === "ground");
      const nextState = anyOnGround ? "flying" : "ground";

      // منع الكلج: التحقق من وجود مهلة كافية وتغيير حقيقي للحالة
      const cooldownMs = 4000;
      const lastReward = nextState === "flying" ? player.lastTakeoffRewardAt : player.lastLandRewardAt;

      let changedCount = 0;
      for (const bird of targetBirds) {
        if (bird.state !== nextState) {
          bird.state = nextState;
          bird.lastActionAt = now;
          changedCount++;
        }
      }

      if (changedCount > 0 && now - lastReward >= cooldownMs) {
        // مكافأة متوازنة وثابتة (25 فقط وليس 100 كل ضغطة) وبشرط تغيير الحالة فعلاً
        const reward = 25;
        player.balance += reward;
        if (nextState === "flying") {
          player.lastTakeoffRewardAt = now;
        } else {
          player.lastLandRewardAt = now;
        }
        sendJson(player, {
          type: "toast",
          text: nextState === "flying" ? `أقلعت الطيور في الجو (+${reward})` : `نزلت الطيور إلى السطح (+${reward})`
        });
      } else if (changedCount > 0) {
        sendJson(player, {
          type: "toast",
          text: nextState === "flying" ? "أقلعت الطيور في الجو" : "نزلت الطيور إلى السطح"
        });
      }
      break;
    }

    case "buy_bird": {
      const spec = MARKET_MAP.get(msg.speciesId);
      if (!spec) break;
      if (player.balance < spec.price) {
        sendJson(player, { type: "toast", text: "رصيدك غير كافٍ لشراء هذا الطير" });
        break;
      }
      if (player.birds.length >= 12) {
        sendJson(player, { type: "toast", text: "وصلت للحد الأقصى لعدد الطيور (12)" });
        break;
      }

      player.balance -= spec.price;
      player.birds.push({
        uid: `${player.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        speciesId: spec.id,
        name: spec.name,
        x: 185 + (player.birds.length % 4) * 35,
        y: 345 + (player.birds.length % 3) * 25,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        angle: Math.random() * Math.PI * 2,
        state: "ground",
        lastActionAt: now
      });

      sendJson(player, { type: "toast", text: `تم شراء ${spec.name} بنجاح` });
      break;
    }

    // طلب زيارة سطح لاعب آخر
    case "request_visit": {
      const targetId = msg.targetPlayerId;
      if (!targetId || targetId === player.id) break;
      const host = players.get(targetId);
      if (!host) {
        sendJson(player, { type: "toast", text: "اللاعب غير متوفر حالياً" });
        break;
      }

      const reqId = crypto.randomBytes(6).toString("hex");
      visitRequests.set(reqId, {
        id: reqId,
        fromId: player.id,
        toId: host.id,
        createdAt: now
      });

      sendJson(host, {
        type: "visit_request",
        requestId: reqId,
        fromId: player.id,
        fromName: player.name
      });
      sendJson(player, { type: "toast", text: `تم إرسال طلب زيارة سطح ${host.name}` });
      break;
    }

    // رد المضيف على طلب الزيارة: يثبت الزائر على سطح المضيف ولا يعيده لسطحه
    case "respond_visit": {
      const req = visitRequests.get(msg.requestId);
      if (!req || req.toId !== player.id) break;
      visitRequests.delete(req.id);

      const visitor = players.get(req.fromId);
      if (!visitor) break;

      if (msg.accept) {
        visitor.viewingOwnerId = player.id;
        visitor.x = 340;
        visitor.y = 380;
        sendJson(visitor, {
          type: "visit_accepted",
          hostId: player.id,
          hostName: player.name
        });
        sendJson(player, {
          type: "toast",
          text: `${visitor.name} الآن على سطحك`
        });
      } else {
        sendJson(visitor, {
          type: "toast",
          text: `رفض ${player.name} طلب الزيارة`
        });
      }
      break;
    }

    // العودة إلى سطح اللاعب الخاص عند رغبته فقط
    case "return_home": {
      player.viewingOwnerId = player.id;
      player.x = 450;
      player.y = 390;
      sendJson(player, { type: "toast", text: "عدت إلى سطحك" });
      break;
    }

    case "chat": {
      if (typeof msg.text !== "string") break;
      const cleanText = msg.text.trim().slice(0, 180);
      if (!cleanText) break;
      chatMessages.push({
        id: crypto.randomBytes(4).toString("hex"),
        senderId: player.id,
        senderName: player.name,
        text: cleanText,
        time: new Date().toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" })
      });
      if (chatMessages.length > 60) chatMessages.shift();
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const htmlPath = path.join(__dirname, "index.html");
    fs.readFile(htmlPath, (err, content) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("تعذر تحميل index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n"
    ].join("\r\n")
  );

  const playerId = crypto.randomBytes(6).toString("hex");
  const player = createPlayer(playerId, `لاعب_${playerId.slice(0, 4)}`);
  player.ws = socket;
  players.set(playerId, player);

  sendJson(player, {
    type: "welcome",
    id: player.id,
    name: player.name,
    balance: player.balance,
    market: MARKET_BIRDS
  });

  let rxBuffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    const parsed = decodeWsFrames(rxBuffer);
    rxBuffer = parsed.remaining;

    for (const item of parsed.messages) {
      if (item && item.__pong) {
        try {
          socket.write(item.__pong);
        } catch (_) {}
      } else {
        handleClientMessage(player, item);
      }
    }

    if (parsed.closed) {
      socket.end();
    }
  });

  const cleanup = () => {
    players.delete(playerId);
    // إذا كان لاعب آخر يزور سطح هذا اللاعب، ننقله لسطحه بأمان
    for (const p of players.values()) {
      if (p.viewingOwnerId === playerId) {
        p.viewingOwnerId = p.id;
      }
    }
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

setInterval(() => {
  stepPhysics();
  broadcast(getPublicWorldSnapshot());
}, 50);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
