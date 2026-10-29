const express = require("express");
const http = require("http");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const ANTE = 25;
const MAX_DEBT = 500;

const db = new sqlite3.Database("./game.db");

const shopItems = [
  { id: "classic", name: "Classic Green", type: "theme", cost: 0 },
  { id: "royal", name: "Royal Blue", type: "theme", cost: 150 },
  { id: "midnight", name: "Midnight", type: "theme", cost: 250 },
  { id: "gold", name: "Gold Cards", type: "cardBack", cost: 150 },
  { id: "neon", name: "Neon Cards", type: "cardBack", cost: 220 },
  { id: "fire", name: "Fire Table", type: "theme", cost: 300 }
];

const rooms = new Map();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      chips INTEGER DEFAULT 1000,
      debt INTEGER DEFAULT 0,
      theme TEXT DEFAULT 'classic',
      cardBack TEXT DEFAULT 'classic',
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      UNIQUE(user_id, item_id)
    )
  `);

  // seed default inventory if needed
  db.all("SELECT * FROM users", (err, rows) => {
    if (err) return;
    rows.forEach((user) => {
      const builtIns = ["classic"];
      builtIns.forEach((itemId) => {
        db.run(
          "INSERT OR IGNORE INTO inventory (user_id, item_id) VALUES (?, ?)",
          [user.id, itemId]
        );
      });
    });
  });
});

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sanitizeName(name) {
  return String(name || "Player").trim().slice(0, 20) || "Player";
}

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getUserByUsername(username, cb) {
  db.get("SELECT * FROM users WHERE username = ?", [username], cb);
}

function getUserById(id, cb) {
  db.get("SELECT * FROM users WHERE id = ?", [id], cb);
}

function getInventoryForUser(userId, cb) {
  db.all(
    "SELECT item_id FROM inventory WHERE user_id = ? ORDER BY item_id ASC",
    [userId],
    cb
  );
}

function ensureDefaultInventory(userId) {
  db.run(
    "INSERT OR IGNORE INTO inventory (user_id, item_id) VALUES (?, ?)",
    [userId, "classic"]
  );
}

function getShopStateForUser(userId, cb) {
  getInventoryForUser(userId, (err, rows) => {
    if (err) return cb(err);

    const owned = new Set((rows || []).map((r) => r.item_id));
    const items = shopItems.map((item) => ({
      ...item,
      owned: owned.has(item.id)
    }));

    cb(null, items);
  });
}

function updateUserBalance(userId, chips, debt, cb = () => {}) {
  db.run(
    "UPDATE users SET chips = ?, debt = ? WHERE id = ?",
    [chips, debt, userId],
    cb
  );
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function getPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function createPlayer(socketId, user) {
  return {
    socketId,
    userId: user.id,
    username: user.username,
    chips: user.chips,
    debt: user.debt,
    theme: user.theme || "classic",
    cardBack: user.cardBack || "classic",
    hand: [],
    discardSelection: [],
    ready: false,
    folded: false,
    stood: false,
    bet: 0,
    actionTaken: false,
    lastAction: "Waiting",
    hasLoan: false
  };
}

function createRoom(hostUser) {
  let code;
  do {
    code = createRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    players: [createPlayer(hostUser.socketId, hostUser.user)],
    phase: "lobby",
    currentPot: 0,
    dealerIndex: 0,
    currentBet: 0,
    roundNumber: 1,
    turnIndex: 0,
    lastMessage: "Waiting for players.",
    showdown: null
  };

  rooms.set(code, room);
  return room;
}

function allPlayersReady(room) {
  return room.players.length > 0 && room.players.every((p) => p.ready);
}

function handName(score) {
  const names = [
    "High Card",
    "One Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush",
    "Royal Flush"
  ];
  return names[score.rank];
}

function getStraightHigh(values) {
  const unique = [...new Set(values)];
  const withLowAce = unique.includes(14) ? [1, ...unique] : unique;
  const normalized = [...new Set(withLowAce)].sort((a, b) => a - b);

  for (let i = 0; i <= normalized.length - 5; i++) {
    const segment = normalized.slice(i, i + 5);
    if (new Set(segment).size === 5 && segment[4] - segment[0] === 4) {
      return segment[4];
    }
  }

  const lowStraight = [1, 2, 3, 4, 5];
  if (lowStraight.every((n) => normalized.includes(n))) return 5;

  return null;
}

function evaluateHand(cards) {
  const values = cards
    .map((c) => {
      const rankMap = {
        "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
        "10": 10, J: 11, Q: 12, K: 13, A: 14
      };
      return rankMap[c.rank];
    })
    .sort((a, b) => a - b);

  const counts = {};
  for (const v of values) {
    counts[v] = (counts[v] || 0) + 1;
  }

  const sortedCounts = Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) return Number(b[1]) - Number(a[1]);
    return Number(b[0]) - Number(a[0]);
  });

  const flush = cards.every((c) => c.suit === cards[0].suit);
  const straightHigh = getStraightHigh(values);

  if (flush && straightHigh) {
    if (straightHigh === 14) return { rank: 9, tiebreak: [14] };
    return { rank: 8, tiebreak: [straightHigh] };
  }

  if (sortedCounts[0][1] === 4) {
    const quad = Number(sortedCounts[0][0]);
    const kicker = Number(sortedCounts[1][0]);
    return { rank: 7, tiebreak: [quad, kicker] };
  }

  if (sortedCounts[0][1] === 3 && sortedCounts[1][1] === 2) {
    const triple = Number(sortedCounts[0][0]);
    const pair = Number(sortedCounts[1][0]);
    return { rank: 6, tiebreak: [triple, pair] };
  }

  if (flush) {
    return { rank: 5, tiebreak: [...values].sort((a, b) => b - a) };
  }

  if (straightHigh) {
    return { rank: 4, tiebreak: [straightHigh] };
  }

  if (sortedCounts[0][1] === 3) {
    const triple = Number(sortedCounts[0][0]);
    const kickers = sortedCounts.slice(1).map((item) => Number(item[0])).sort((a, b) => b - a);
    return { rank: 3, tiebreak: [triple, ...kickers] };
  }

  if (sortedCounts[0][1] === 2 && sortedCounts[1][1] === 2) {
    const pair1 = Number(sortedCounts[0][0]);
    const pair2 = Number(sortedCounts[1][0]);
    const kicker = Number(sortedCounts[2][0]);
    return { rank: 2, tiebreak: [Math.max(pair1, pair2), Math.min(pair1, pair2), kicker] };
  }

  if (sortedCounts[0][1] === 2) {
    const pair = Number(sortedCounts[0][0]);
    const kickers = sortedCounts.slice(1).map((item) => Number(item[0])).sort((a, b) => b - a);
    return { rank: 1, tiebreak: [pair, ...kickers] };
  }

  return { rank: 0, tiebreak: [...values].sort((a, b) => b - a) };
}

function compareScores(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;

  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;

    if (av !== bv) return av - bv;
  }

  return 0;
}

function shuffleDeckForRoom(room) {
  room.deck = shuffle(createDeck());
  room.players.forEach((player) => {
    player.hand = [];
    player.ready = false;
    player.folded = false;
    player.stood = false;
    player.bet = 0;
    player.actionTaken = false;
    player.lastAction = "Waiting";
    for (let i = 0; i < 5; i++) {
      player.hand.push(room.deck.pop());
    }
  });
}

function emitRoomState(room) {
  const payload = {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    currentPot: room.currentPot,
    currentBet: room.currentBet,
    lastMessage: room.lastMessage,
    dealerIndex: room.dealerIndex,
    players: room.players.map((p, index) => ({
      id: p.socketId,
      username: p.username,
      chips: p.chips,
      debt: p.debt,
      ready: p.ready,
      folded: p.folded,
      stood: p.stood,
      bet: p.bet,
      isDealer: index === room.dealerIndex,
      lastAction: p.lastAction,
      theme: p.theme,
      cardBack: p.cardBack
    }))
  };

  io.to(room.code).emit("roomState", payload);
}

function emitPlayerCards(room) {
  room.players.forEach((player) => {
    io.to(player.socketId).emit("yourCards", {
      hand: player.hand,
      chips: player.chips,
      debt: player.debt,
      phase: room.phase,
      currentPot: room.currentPot,
      currentBet: room.currentBet,
      roundNumber: room.roundNumber,
      dealerIndex: room.dealerIndex
    });
  });
}

function updatePersistentUser(player) {
  getUserById(player.userId, (err, user) => {
    if (err || !user) return;

    const nextChips = Number(player.chips) || 0;
    const nextDebt = Number(player.debt) || 0;

    updateUserBalance(player.userId, nextChips, nextDebt);
  });
}

function addLoanIfNeeded(player) {
  if (player.chips <= 0 && player.debt < MAX_DEBT) {
    const loan = 100;
    player.chips += loan;
    player.debt += loan;
    player.hasLoan = true;
    player.lastAction = "Loan granted";
    return true;
  }
  return false;
}

function finishHand(room) {
  const pot = room.currentPot;
  const results = room.players
    .filter((p) => !p.folded)
    .map((player) => {
      const score = evaluateHand(player.hand);
      return {
        id: player.id,
        socketId: player.socketId,
        username: player.username,
        score,
        handName: handName(score),
        hand: player.hand
      };
    });

  if (results.length === 0) {
    room.phase = "lobby";
    room.currentPot = 0;
    room.currentBet = 0;
    room.lastMessage = "Everyone folded, no showdown.";
    room.players.forEach((player) => {
      player.hand = [];
      player.folded = false;
      player.stood = false;
      player.ready = false;
      player.bet = 0;
    });
    emitRoomState(room);
    return;
  }

  const winner = results.reduce((best, curr) => {
    return compareScores(curr.score, best.score) > 0 ? curr : best;
  }, results[0]);

  const winnerPlayer = room.players.find((p) => p.socketId === winner.socketId);
  if (winnerPlayer) {
    winnerPlayer.chips += pot;
  }

  // pay debt from winnings
  room.players.forEach((player) => {
    if (player.debt > 0 && player.chips > 0) {
      const debtPayment = Math.min(player.chips, Math.ceil(player.debt * 0.25));
      player.chips -= debtPayment;
      player.debt -= debtPayment;
    }
  });

  room.players.forEach((player) => {
    player.hand = [];
    player.folded = false;
    player.stood = false;
    player.ready = false;
    player.bet = 0;
  });

  room.phase = "lobby";
  room.currentPot = 0;
  room.currentBet = 0;
  room.roundNumber += 1;
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  room.lastMessage = `${winner.username} wins with ${winner.handName}!`;

  room.players.forEach((player) => {
    if (player.userId) updatePersistentUser(player);
  });

  io.to(room.code).emit("showdown", {
    winnerName: winner.username,
    pot,
    results: results.map((r) => ({
      id: r.socketId,
      name: r.username,
      handName: r.handName,
      hand: r.hand
    })),
    explanation: `${winner.username} wins with ${winner.handName}.`
  });

  emitRoomState(room);
}

function findNextActivePlayer(room, currentIndex) {
  const len = room.players.length;
  for (let i = 1; i <= len; i++) {
    const index = (currentIndex + i) % len;
    const player = room.players[index];
    if (player && !player.folded) return index;
  }
  return -1;
}

function startRound(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  if (room.players.length < 2) {
    io.to(roomCode).emit("error", { message: "You need at least 2 players to start a hand." });
    return;
  }

  room.phase = "bet1";
  room.currentPot = 0;
  room.currentBet = 0;
  room.lastMessage = "Betting round 1 has started.";

  room.players.forEach((player) => {
    player.chips = Number(player.chips) || 0;
    player.bet = 0;
    player.folded = false;
    player.stood = false;
    player.ready = false;
    player.actionTaken = false;
    player.lastAction = "Waiting";
    if (player.chips <= 0 && player.debt < MAX_DEBT) {
      addLoanIfNeeded(player);
    }
  });

  shuffleDeckForRoom(room);
  emitPlayerCards(room);
  emitRoomState(room);
}

function processBetAction(room, player, action, amount = 0) {
  if (action === "fold") {
    player.folded = true;
    player.lastAction = "Folded";
    player.stood = false;
    player.bet = 0;
    room.lastMessage = `${player.username} folded.`;
    return;
  }

  if (action === "stand") {
    player.stood = true;
    player.lastAction = "Stand";
    room.lastMessage = `${player.username} stood pat.`;
    return;
  }

  if (action === "check") {
    if (room.currentBet > 0) {
      io.to(player.socketId).emit("error", { message: "You cannot check when there is a bet on the table." });
      return;
    }
    player.lastAction = "Checked";
    room.lastMessage = `${player.username} checked.`;
    return;
  }

  if (action === "call") {
    if (room.currentBet <= 0) {
      io.to(player.socketId).emit("error", { message: "You cannot call without a bet." });
      return;
    }

    const needed = room.currentBet - (player.bet || 0);
    if (player.chips < needed) {
      if (player.debt < MAX_DEBT) {
        addLoanIfNeeded(player);
      }
      if (player.chips < needed) {
        io.to(player.socketId).emit("error", { message: "Not enough chips or debt capacity." });
        return;
      }
    }

    player.chips -= needed;
    player.bet += needed;
    player.lastAction = `Called ${needed}`;
    room.currentPot += needed;
    room.lastMessage = `${player.username} called for ${needed}.`;
    return;
  }

  if (action === "raise") {
    const raiseAmount = Number(amount) || 0;
    if (raiseAmount <= 0) {
      io.to(player.socketId).emit("error", { message: "Raise amount must be greater than 0." });
      return;
    }

    const totalNeeded = room.currentBet + raiseAmount - (player.bet || 0);
    if (player.chips < totalNeeded) {
      if (player.debt < MAX_DEBT) {
        addLoanIfNeeded(player);
      }
      if (player.chips < totalNeeded) {
        io.to(player.socketId).emit("error", { message: "Not enough chips or debt capacity." });
        return;
      }
    }

    player.chips -= totalNeeded;
    player.bet += totalNeeded;
    room.currentBet += raiseAmount;
    room.currentPot += totalNeeded;
    player.lastAction = `Raised ${raiseAmount}`;
    room.lastMessage = `${player.username} raised to ${room.currentBet}.`;
    return;
  }

  io.to(player.socketId).emit("error", { message: "Unknown action." });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", (socket) => {
  socket.on("register", ({ username, password }) => {
    const cleanName = sanitizeName(username);
    if (!cleanName || cleanName.length < 2) {
      socket.emit("authResult", { success: false, message: "Username must be at least 2 characters." });
      return;
    }
    if (!password || password.length < 3) {
      socket.emit("authResult", { success: false, message: "Password must be at least 3 characters." });
      return;
    }

    getUserByUsername(cleanName, (err, existing) => {
      if (err) return;
      if (existing) {
        socket.emit("authResult", { success: false, message: "Username already taken." });
        return;
      }

      db.run(
        "INSERT INTO users (username, password, chips, debt, theme, cardBack) VALUES (?, ?, 1000, 0, 'classic', 'classic')",
        [cleanName, password],
        function () {
          const userId = this.lastID;
          ensureDefaultInventory(userId);
          socket.emit("authResult", {
            success: true,
            message: "Account created!",
            user: { id: userId, username: cleanName, chips: 1000, debt: 0, theme: "classic", cardBack: "classic" }
          });
        }
      );
    });
  });

  socket.on("login", ({ username, password }) => {
    const cleanName = sanitizeName(username);
    getUserByUsername(cleanName, (err, user) => {
      if (err || !user) {
        socket.emit("authResult", { success: false, message: "Account not found." });
        return;
      }
      if (user.password !== password) {
        socket.emit("authResult", { success: false, message: "Incorrect password." });
        return;
      }

      getInventoryForUser(user.id, (inventoryErr, inventoryRows) => {
        if (inventoryErr) return;
        const inventory = inventoryRows.map((r) => r.item_id);
        socket.emit("authResult", {
          success: true,
          message: "Welcome back!",
          user: {
            id: user.id,
            username: user.username,
            chips: user.chips,
            debt: user.debt,
            theme: user.theme || "classic",
            cardBack: user.cardBack || "classic",
            inventory
          }
        });
      });
    });
  });

  socket.on("getShop", ({ userId }) => {
    getShopStateForUser(userId, (err, items) => {
      if (err || !items) {
        socket.emit("shopState", { items: [] });
        return;
      }
      socket.emit("shopState", { items });
    });
  });

  socket.on("buyItem", ({ userId, itemId }) => {
    if (!userId || !itemId) return;

    getUserById(userId, (err, user) => {
      if (err || !user) return;

      const item = shopItems.find((i) => i.id === itemId);
      if (!item) return;

      getInventoryForUser(userId, (invErr, inventoryRows) => {
        if (invErr) return;

        const owned = new Set(inventoryRows.map((r) => r.item_id));
        if (owned.has(itemId)) {
          socket.emit("shopResult", { success: false, message: "You already own this item." });
          return;
        }

        if (user.chips < item.cost) {
          socket.emit("shopResult", { success: false, message: "Not enough chips to buy this item." });
          return;
        }

        const newChips = user.chips - item.cost;
        db.run(
          "INSERT INTO inventory (user_id, item_id) VALUES (?, ?)",
          [userId, itemId],
          () => {
            db.run(
              "UPDATE users SET chips = ?, theme = ?, cardBack = ? WHERE id = ?",
              [newChips, item.type === "theme" ? itemId : user.theme, item.type === "cardBack" ? itemId : user.cardBack, userId],
              () => {
                socket.emit("shopResult", {
                  success: true,
                  message: `Bought ${item.name}!`,
                  itemId,
                  purchasedChips: newChips
                });
              }
            );
          }
        );
      });
    });
  });

  socket.on("setActiveCosmetic", ({ userId, itemId }) => {
    if (!userId || !itemId) return;

    getUserById(userId, (err, user) => {
      if (err || !user) return;

      const item = shopItems.find((i) => i.id === itemId);
      if (!item) return;

      getInventoryForUser(userId, (invErr, inventoryRows) => {
        if (invErr) return;

        const owned = new Set(inventoryRows.map((r) => r.item_id));
        if (!owned.has(itemId)) {
          socket.emit("shopResult", { success: false, message: "You must buy it first." });
          return;
        }

        const updates = {};
        if (item.type === "theme") updates.theme = itemId;
        if (item.type === "cardBack") updates.cardBack = itemId;

        db.run(
          `UPDATE users SET ${Object.keys(updates).map((key) => `${key} = ?`).join(", ")} WHERE id = ?`,
          [...Object.values(updates), userId],
          () => {
            socket.emit("shopResult", {
              success: true,
              message: `Equipped ${item.name}!`,
              itemId
            });
          }
        );
      });
    });
  });

  socket.on("createRoom", ({ userId }) => {
    if (!userId) {
      socket.emit("error", { message: "You must log in first." });
      return;
    }

    getUserById(userId, (err, user) => {
      if (err || !user) {
        socket.emit("error", { message: "No user found." });
        return;
      }

      const host = {
        socketId: socket.id,
        user: user
      };

      const room = createRoom(host);
      room.lastMessage = `${user.username} created room ${room.code}.`;
      socket.join(room.code);
      socket.emit("joinedRoom", {
        code: room.code,
        userId: user.id,
        username: user.username
      });
      emitRoomState(room);
    });
  });

  socket.on("joinRoom", ({ userId, code }) => {
    if (!userId) {
      socket.emit("error", { message: "You must log in first." });
      return;
    }

    const roomCode = String(code || "").toUpperCase();
    const room = getRoom(roomCode);

    if (!room) {
      socket.emit("error", { message: "Room not found." });
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("error", { message: "This room is full." });
      return;
    }

    getUserById(userId, (err, user) => {
      if (err || !user) {
        socket.emit("error", { message: "User not found." });
        return;
      }

      const player = createPlayer(socket.id, user);
      room.players.push(player);
      socket.join(room.code);
      socket.emit("joinedRoom", {
        code: room.code,
        userId: user.id,
        username: user.username
      });

      room.lastMessage = `${user.username} joined the room.`;
      emitRoomState(room);
    });
  });

  socket.on("startRound", ({ code }) => {
    const room = getRoom(code);
    if (!room) return;

    if (room.phase !== "lobby") {
      socket.emit("error", { message: "A round is already in progress." });
      return;
    }

    if (room.players.length < 2) {
      socket.emit("error", { message: "You need at least 2 players." });
      return;
    }

    startRound(room.code);
  });

  socket.on("betAction", ({ code, action, amount }) => {
    const room = getRoom(code);
    if (!room) return;

    const player = getPlayer(room, socket.id);
    if (!player) return;

    if (room.phase === "lobby") {
      socket.emit("error", { message: "The round has not started yet." });
      return;
    }

    processBetAction(room, player, action, amount);
    emitRoomState(room);
    emitPlayerCards(room);
  });

  socket.on("discardCards", ({ code, cards }) => {
    const room = getRoom(code);
    if (!room) return;

    const player = getPlayer(room, socket.id);
    if (!player) return;

    const safeSelection = [...new Set(cards || [])]
      .map((v) => Number(v))
      .filter((value) => Number.isInteger(value) && value >= 0 && value < 5);

    player.discardSelection = safeSelection;
    player.ready = true;

    if (allPlayersReady(room)) {
      if (room.phase === "draw1") {
        room.phase = "draw2";
        room.lastMessage = "Discard round 2 has started.";
        emitPlayerCards(room);
        emitRoomState(room);
        return;
      }

      if (room.phase === "draw2") {
        replaceDiscardedCards(room);
        finishHand(room);
      }
    } else {
      emitRoomState(room);
    }
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const index = room.players.findIndex((p) => p.socketId === socket.id);

      if (index === -1) continue;

      const removed = room.players[index];
      room.players.splice(index, 1);

      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }

      if (index <= room.dealerIndex) room.dealerIndex = Math.max(0, room.dealerIndex - 1);

      if (room.dealerIndex >= room.players.length) room.dealerIndex = 0;

      if (room.players.length === 1) room.dealerIndex = 0;

      room.lastMessage = `${removed.username} left the room.`;
      emitRoomState(room);
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});