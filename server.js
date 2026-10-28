const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const ANTE = 25;

const rooms = new Map();

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

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function sanitizeName(name) {
  return String(name || "Player").trim().slice(0, 20) || "Player";
}

function getRoom(code) {
  return rooms.get(code.toUpperCase());
}

function getPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function createPlayer(id, name) {
  return {
    id,
    name,
    chips: 1000,
    hand: [],
    discardSelection: [],
    ready: false
  };
}

function createRoom(hostName, hostId) {
  let code;
  do {
    code = createRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    players: [createPlayer(hostId, sanitizeName(hostName))],
    dealerIndex: 0,
    phase: "lobby",
    deck: [],
    currentPot: 0,
    roundNumber: 1
  };

  rooms.set(code, room);
  return room;
}

function advanceDealer(room) {
  if (room.players.length === 0) return;
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
}

function emitRoomState(room) {
  io.to(room.code).emit("roomState", {
    code: room.code,
    phase: room.phase,
    dealerIndex: room.dealerIndex,
    currentPot: room.currentPot,
    ante: ANTE,
    roundNumber: room.roundNumber,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((p, index) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      ready: p.ready,
      isDealer: index === room.dealerIndex,
      index
    }))
  });
}

function emitPlayerCards(room) {
  room.players.forEach((player) => {
    io.to(player.id).emit("yourCards", {
      hand: player.hand,
      chips: player.chips,
      phase: room.phase,
      currentPot: room.currentPot,
      dealerIndex: room.dealerIndex,
      roundNumber: room.roundNumber
    });
  });
}

function allPlayersReady(room) {
  return room.players.length > 0 && room.players.every((p) => p.ready);
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
  const values = cards.map((c) => {
    const rankMap = {
      "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
      "10": 10, J: 11, Q: 12, K: 13, A: 14
    };
    return rankMap[c.rank];
  }).sort((a, b) => a - b);

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

function compareScores(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;

  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;

    if (av !== bv) return av - bv;
  }

  return 0;
}

function dealHands(room) {
  room.deck = shuffle(createDeck());

  room.players.forEach((player) => {
    player.hand = [];
    player.ready = false;
    player.discardSelection = [];

    for (let i = 0; i < 5; i++) {
      player.hand.push(room.deck.pop());
    }
  });
}

function replaceDiscardedCards(room) {
  room.players.forEach((player) => {
    if (!player.discardSelection || player.discardSelection.length === 0) {
      player.discardSelection = [];
      player.ready = false;
      return;
    }

    const indexes = [...new Set(player.discardSelection)].sort((a, b) => b - a);

    for (const index of indexes) {
      if (index >= 0 && index < player.hand.length && room.deck.length > 0) {
        player.hand[index] = room.deck.pop();
      }
    }

    player.discardSelection = [];
    player.ready = false;
  });
}

function startRound(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  if (room.players.length < 2) {
    io.to(roomCode).emit("error", { message: "You need at least 2 players to start a hand." });
    return;
  }

  if (room.players.some((p) => p.chips < ANTE)) {
    io.to(roomCode).emit("error", { message: "Every player needs at least 25 chips to play the next hand." });
    return;
  }

  room.phase = "draw1";
  room.currentPot = room.players.length * ANTE;

  room.players.forEach((player) => {
    player.chips -= ANTE;
    player.ready = false;
    player.discardSelection = [];
  });

  dealHands(room);

  emitPlayerCards(room);
  emitRoomState(room);
}

function finishHand(room) {
  const pot = room.currentPot;
  const results = room.players.map((player) => {
    const score = evaluateHand(player.hand);
    return {
      id: player.id,
      name: player.name,
      hand: player.hand,
      score,
      handName: handName(score)
    };
  });

  const winner = results.reduce((best, curr) => {
    return compareScores(curr.score, best.score) > 0 ? curr : best;
  }, results[0]);

  const winnerPlayer = room.players.find((p) => p.id === winner.id);
  winnerPlayer.chips += pot;

  room.phase = "lobby";
  room.currentPot = 0;
  room.roundNumber += 1;
  room.players.forEach((player) => {
    player.hand = [];
    player.ready = false;
    player.discardSelection = [];
  });

  advanceDealer(room);

  io.to(room.code).emit("showdown", {
    winnerId: winner.id,
    winnerName: winnerPlayer.name,
    pot,
    results: results.map((r) => ({
      id: r.id,
      name: r.name,
      handName: r.handName,
      hand: r.hand
    }))
  });

  emitRoomState(room);
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }) => {
    const cleanName = sanitizeName(name);
    const room = createRoom(cleanName, socket.id);
    socket.join(room.code);
    socket.emit("joinedRoom", { code: room.code, playerId: socket.id });
    emitRoomState(room);
  });

  socket.on("joinRoom", ({ code, name }) => {
    const roomCode = String(code || "").toUpperCase();
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit("error", { message: "Room not found." });
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("error", { message: "This room is full. Max 6 players." });
      return;
    }

    if (room.phase !== "lobby") {
      socket.emit("error", { message: "This hand is already in progress." });
      return;
    }

    const player = createPlayer(socket.id, sanitizeName(name));
    room.players.push(player);
    socket.join(room.code);

    socket.emit("joinedRoom", { code: room.code, playerId: socket.id });
    emitRoomState(room);
  });

  socket.on("startRound", ({ code }) => {
    const room = getRoom(code);
    if (!room) return;

    if (room.phase !== "lobby") {
      socket.emit("error", { message: "A round is already in progress." });
      return;
    }

    startRound(room.code);
  });

  socket.on("discardCards", ({ code, cards }) => {
    const room = getRoom(code);
    if (!room) return;

    const player = getPlayer(room, socket.id);
    if (!player) return;

    const safeSelection = [...new Set(cards || [])]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value < 5);

    player.discardSelection = safeSelection;
    player.ready = true;

    if (allPlayersReady(room)) {
      if (room.phase === "draw1") {
        replaceDiscardedCards(room);
        room.phase = "draw2";
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
      const index = room.players.findIndex((p) => p.id === socket.id);

      if (index === -1) continue;

      room.players.splice(index, 1);

      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }

      if (index <= room.dealerIndex) {
        room.dealerIndex = Math.max(0, room.dealerIndex - 1);
      }

      if (room.dealerIndex >= room.players.length) {
        room.dealerIndex = 0;
      }

      if (room.players.length === 1) {
        room.dealerIndex = 0;
      }

      emitRoomState(room);
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});