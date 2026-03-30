const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const allowedOrigin = '*';
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
  },
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = '123456789';
const MAX_ROOM_GENERATION_ATTEMPTS = 2000;
const DEFAULT_MATCH_DURATION_SECONDS = 5 * 60;
const rooms = new Map();

function generateRoomCode() {
  for (let attempt = 0; attempt < MAX_ROOM_GENERATION_ATTEMPTS; attempt += 1) {
    let code = '';

    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
      const randomIndex = Math.floor(Math.random() * ROOM_CODE_CHARS.length);
      code += ROOM_CODE_CHARS[randomIndex];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error('Unable to generate a unique room code.');
}

function generatePlayerId() {
  return crypto.randomUUID();
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase();
}

function normalizeDurationSeconds(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MATCH_DURATION_SECONDS;
  }

  return Math.round(parsed);
}

function createPlayer(name, fallbackName) {
  return {
    name: typeof name === 'string' && name.trim() ? name.trim() : fallbackName,
    joinedAt: new Date().toISOString(),
    socketId: null,
  };
}

function getRoomEntity(roomCode) {
  return rooms.get(roomCode) ?? null;
}

function getPlayer(roomCode, playerId) {
  const room = getRoomEntity(roomCode);
  if (!room) {
    return null;
  }
  return room.players.get(playerId) ?? null;
}

function clearMatchTimeout(room) {
  if (room.currentMatchTimeout) {
    clearTimeout(room.currentMatchTimeout);
    room.currentMatchTimeout = null;
  }
}

function getParticipantSnapshot(room) {
  if (!room.currentMatch) {
    return [];
  }

  return Array.from(room.currentMatch.playerNames.entries()).map(([playerId, name]) => ({
    playerId,
    name,
    score: room.currentMatch.scores.get(playerId) ?? 0,
    status: room.currentMatch.playerStatuses.get(playerId) ?? 'playing',
  }));
}

function buildMatchResult(room) {
  if (!room.currentMatch) {
    return null;
  }

  const standings = getParticipantSnapshot(room)
    .sort((left, right) => right.score - left.score)
    .map((entry, index) => ({
      ...entry,
      place: index + 1,
    }));

  return {
    winnerPlayerId: standings[0]?.playerId ?? null,
    standings,
  };
}

function getPublicMatch(room) {
  if (!room.currentMatch) {
    return null;
  }

  return {
    matchId: room.currentMatch.matchId,
    status: room.currentMatch.status,
    durationSeconds: room.currentMatch.durationSeconds,
    startedAt: room.currentMatch.startedAt,
    endsAt: room.currentMatch.endsAt,
    scores: Object.fromEntries(room.currentMatch.scores.entries()),
    playerStatuses: Object.fromEntries(room.currentMatch.playerStatuses.entries()),
    participants: getParticipantSnapshot(room),
    endedReason: room.currentMatch.endedReason,
    result: room.currentMatch.result,
  };
}

function getPublicRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) {
    return null;
  }

  return {
    roomCode,
    hostSocketId: room.hostSocketId,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.players.size,
    players: Array.from(room.players).map(([playerId, player]) => ({
      playerId,
      socketId: player.socketId ?? null,
      name: player.name,
      joinedAt: player.joinedAt,
      isHost: playerId === room.hostPlayerId,
    })),
    matchDurationSeconds: room.matchDurationSeconds,
    currentMatch: getPublicMatch(room),
  };
}

function emitRoomSnapshot(roomCode) {
  const publicRoom = getPublicRoom(roomCode);
  if (!publicRoom) {
    return null;
  }

  io.to(roomCode).emit('roomUpdated', publicRoom);
  return publicRoom;
}

function finishMatch(roomCode, reason = 'completed') {
  const room = getRoomEntity(roomCode);
  if (!room || !room.currentMatch || room.currentMatch.status !== 'active') {
    return null;
  }

  clearMatchTimeout(room);
  room.currentMatch.status = 'finished';
  room.currentMatch.endedReason = reason;
  room.currentMatch.result = buildMatchResult(room);

  for (const [playerId, status] of room.currentMatch.playerStatuses.entries()) {
    if (status === 'playing') {
      room.currentMatch.playerStatuses.set(playerId, 'waiting');
    }
  }

  const publicRoom = getPublicRoom(roomCode);
  io.to(roomCode).emit('matchFinished', publicRoom);
  io.to(roomCode).emit('roomUpdated', publicRoom);
  return publicRoom;
}

function shouldFinishMatch(room) {
  if (!room.currentMatch) {
    return false;
  }

  for (const status of room.currentMatch.playerStatuses.values()) {
    if (status === 'playing') {
      return false;
    }
  }

  return true;
}

function startMatchForRoom(roomCode, playerId) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const room = getRoomEntity(normalizedRoomCode);

  if (!room) {
    return { ok: false, message: 'Room not found.' };
  }

  if (room.hostPlayerId !== playerId) {
    return { ok: false, message: 'Only the host can start the match.' };
  }

  if (room.players.size < 2) {
    return { ok: false, message: 'Need at least 2 players to start the match.' };
  }

  clearMatchTimeout(room);

  const now = Date.now();
  const durationSeconds = room.matchDurationSeconds;
  const scores = new Map();
  const playerStatuses = new Map();
  const playerNames = new Map();

  for (const [currentPlayerId, player] of room.players.entries()) {
    scores.set(currentPlayerId, 0);
    playerStatuses.set(currentPlayerId, 'playing');
    playerNames.set(currentPlayerId, player.name);
  }

  room.currentMatch = {
    matchId: crypto.randomUUID(),
    status: 'active',
    durationSeconds,
    startedAt: new Date(now).toISOString(),
    endsAt: durationSeconds == null ? null : new Date(now + durationSeconds * 1000).toISOString(),
    scores,
    playerStatuses,
    playerNames,
    endedReason: null,
    result: null,
  };

  if (durationSeconds != null) {
    room.currentMatchTimeout = setTimeout(() => {
      finishMatch(normalizedRoomCode, 'time_up');
    }, durationSeconds * 1000);
  }

  return { ok: true, room: getPublicRoom(normalizedRoomCode) };
}

function updateMatchScore(roomCode, playerId, score) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const room = getRoomEntity(normalizedRoomCode);
  const player = getPlayer(normalizedRoomCode, playerId);

  if (!room || !player) {
    return { ok: false, message: 'Room or player not found.' };
  }

  if (!room.currentMatch || room.currentMatch.status !== 'active') {
    return { ok: false, message: 'No active match in this room.' };
  }

  if (room.currentMatch.playerStatuses.get(playerId) !== 'playing') {
    return { ok: true, room: getPublicRoom(normalizedRoomCode) };
  }

  room.currentMatch.scores.set(playerId, Number(score) || 0);
  const publicRoom = getPublicRoom(normalizedRoomCode);
  io.to(normalizedRoomCode).emit('matchUpdated', publicRoom);
  io.to(normalizedRoomCode).emit('roomUpdated', publicRoom);
  return { ok: true, room: publicRoom };
}

function completeMatchRun(roomCode, playerId, score) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const room = getRoomEntity(normalizedRoomCode);
  const player = getPlayer(normalizedRoomCode, playerId);

  if (!room || !player) {
    return { ok: false, message: 'Room or player not found.' };
  }

  if (!room.currentMatch || room.currentMatch.status !== 'active') {
    return { ok: false, message: 'No active match in this room.' };
  }

  room.currentMatch.scores.set(playerId, Number(score) || 0);
  room.currentMatch.playerStatuses.set(playerId, 'waiting');

  if (shouldFinishMatch(room)) {
    return { ok: true, room: finishMatch(normalizedRoomCode, 'all_players_waiting') };
  }

  const publicRoom = getPublicRoom(normalizedRoomCode);
  io.to(normalizedRoomCode).emit('matchUpdated', publicRoom);
  io.to(normalizedRoomCode).emit('roomUpdated', publicRoom);
  return { ok: true, room: publicRoom };
}

function createRoomForPlayer(name, durationSeconds) {
  const roomCode = generateRoomCode();
  const playerId = generatePlayerId();
  const player = createPlayer(name, 'Host');

  rooms.set(roomCode, {
    hostSocketId: null,
    hostPlayerId: playerId,
    players: new Map([[playerId, player]]),
    matchDurationSeconds: durationSeconds,
    currentMatch: null,
    currentMatchTimeout: null,
  });

  return {
    roomCode,
    playerId,
    room: getPublicRoom(roomCode),
  };
}

function joinRoomForPlayer(roomCode, name) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const room = rooms.get(normalizedRoomCode);

  if (!normalizedRoomCode || normalizedRoomCode.length !== ROOM_CODE_LENGTH) {
    return { ok: false, status: 400, message: 'Room code must be 6 characters.' };
  }

  if (!room) {
    return { ok: false, status: 404, message: 'Room not found.' };
  }

  if (room.currentMatch?.status === 'active') {
    return { ok: false, status: 409, message: 'Match already started.' };
  }

  const playerId = generatePlayerId();
  room.players.set(playerId, createPlayer(name, 'Guest'));

  return {
    ok: true,
    roomCode: normalizedRoomCode,
    playerId,
    room: getPublicRoom(normalizedRoomCode),
  };
}

function attachSocketToPlayer(socket, roomCode, playerId) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const room = getRoomEntity(normalizedRoomCode);
  const player = getPlayer(normalizedRoomCode, playerId);

  if (!room || !player) {
    return { ok: false, message: 'Room or player not found.' };
  }

  removePlayerFromRooms(socket.id, { removePlayer: false });

  player.socketId = socket.id;
  if (room.hostPlayerId === playerId) {
    room.hostSocketId = socket.id;
  }

  socket.join(normalizedRoomCode);
  return { ok: true, room: getPublicRoom(normalizedRoomCode) };
}

function handlePlayerLeavingActiveMatch(roomCode, playerId) {
  const room = getRoomEntity(roomCode);
  if (!room || !room.currentMatch || room.currentMatch.status !== 'active') {
    return;
  }

  room.currentMatch.playerStatuses.set(playerId, 'left');
  room.currentMatch.scores.set(playerId, room.currentMatch.scores.get(playerId) ?? 0);

  for (const [otherPlayerId, status] of room.currentMatch.playerStatuses.entries()) {
    if (otherPlayerId !== playerId && status === 'playing') {
      room.currentMatch.playerStatuses.set(otherPlayerId, 'waiting');
    }
  }

  finishMatch(roomCode, 'player_left');
}

function removePlayerFromRooms(socketId, options = {}) {
  const { removePlayer = true } = options;

  for (const [roomCode, room] of rooms.entries()) {
    let matchedPlayerId = null;

    for (const [playerId, player] of room.players.entries()) {
      if (player.socketId === socketId) {
        matchedPlayerId = playerId;
        break;
      }
    }

    if (!matchedPlayerId) {
      continue;
    }

    if (removePlayer) {
      handlePlayerLeavingActiveMatch(roomCode, matchedPlayerId);
      room.players.delete(matchedPlayerId);
    } else {
      const player = room.players.get(matchedPlayerId);
      if (player) {
        player.socketId = null;
      }
    }

    if (room.players.size === 0) {
      clearMatchTimeout(room);
      rooms.delete(roomCode);
      io.emit('roomDeleted', { roomCode });
      continue;
    }

    if (room.hostPlayerId === matchedPlayerId && removePlayer) {
      room.hostPlayerId = room.players.keys().next().value;
    }

    const hostPlayer = room.players.get(room.hostPlayerId);
    room.hostSocketId = hostPlayer?.socketId ?? null;
    emitRoomSnapshot(roomCode);
  }
}

app.get('/', (req, res) => {
  res.send('Block socket server is running');
});

app.get('/rooms/:roomCode', (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = getPublicRoom(roomCode);

  if (!room) {
    return res.status(404).json({ message: 'Room not found' });
  }

  return res.json(room);
});

app.post('/rooms', (req, res) => {
  try {
    const durationSeconds = normalizeDurationSeconds(req.body?.durationSeconds);
    const result = createRoomForPlayer(req.body?.name, durationSeconds);
    return res.status(201).json({
      ok: true,
      roomCode: result.roomCode,
      playerId: result.playerId,
      room: result.room,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/rooms/join', (req, res) => {
  const result = joinRoomForPlayer(req.body?.roomCode, req.body?.name);

  if (!result.ok) {
    return res.status(result.status).json({ ok: false, message: result.message });
  }

  return res.json({
    ok: true,
    roomCode: result.roomCode,
    playerId: result.playerId,
    room: result.room,
  });
});

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, durationSeconds } = {}, callback) => {
    try {
      const result = createRoomForPlayer(name, normalizeDurationSeconds(durationSeconds));
      const attachResult = attachSocketToPlayer(socket, result.roomCode, result.playerId);
      const publicRoom = attachResult.room;

      if (typeof callback === 'function') {
        callback({ ok: true, roomCode: result.roomCode, playerId: result.playerId, room: publicRoom });
      }

      socket.emit('roomCreated', publicRoom);
      emitRoomSnapshot(result.roomCode);
    } catch (error) {
      if (typeof callback === 'function') {
        callback({ ok: false, message: error.message });
      }
    }
  });

  socket.on('joinRoom', ({ roomCode, name } = {}, callback) => {
    const result = joinRoomForPlayer(roomCode, name);

    if (!result.ok) {
      if (typeof callback === 'function') {
        callback({ ok: false, message: result.message });
      }
      return;
    }

    const attachResult = attachSocketToPlayer(socket, result.roomCode, result.playerId);
    const publicRoom = attachResult.room;

    if (typeof callback === 'function') {
      callback({ ok: true, roomCode: result.roomCode, playerId: result.playerId, room: publicRoom });
    }

    socket.emit('roomJoined', publicRoom);
    emitRoomSnapshot(result.roomCode);
  });

  socket.on('attachRoom', ({ roomCode, playerId } = {}, callback) => {
    const result = attachSocketToPlayer(socket, roomCode, playerId);

    if (!result.ok) {
      if (typeof callback === 'function') {
        callback({ ok: false, message: result.message });
      }
      return;
    }

    if (typeof callback === 'function') {
      callback({ ok: true, room: result.room });
    }

    socket.emit('roomAttached', result.room);
    emitRoomSnapshot(normalizeRoomCode(roomCode));
  });

  socket.on('startMatch', ({ roomCode, playerId } = {}, callback) => {
    const result = startMatchForRoom(roomCode, playerId);

    if (typeof callback === 'function') {
      callback(result);
    }

    if (result.ok) {
      const normalizedRoomCode = normalizeRoomCode(roomCode);
      io.to(normalizedRoomCode).emit('matchStarted', result.room);
      emitRoomSnapshot(normalizedRoomCode);
    }
  });

  socket.on('updateMatchScore', ({ roomCode, playerId, score } = {}, callback) => {
    const result = updateMatchScore(roomCode, playerId, score);

    if (typeof callback === 'function') {
      callback(result);
    }
  });

  socket.on('completeMatchRun', ({ roomCode, playerId, score } = {}, callback) => {
    const result = completeMatchRun(roomCode, playerId, score);

    if (typeof callback === 'function') {
      callback(result);
    }
  });

  socket.on('leaveRoom', ({ roomCode, playerId } = {}, callback) => {
    const normalizedRoomCode = normalizeRoomCode(roomCode);
    const room = getRoomEntity(normalizedRoomCode);
    const player = getPlayer(normalizedRoomCode, playerId);

    if (!room || !player) {
      if (typeof callback === 'function') {
        callback({ ok: false, message: 'Room or player not found.' });
      }
      return;
    }

    if (player.socketId === socket.id) {
      player.socketId = null;
    }

    handlePlayerLeavingActiveMatch(normalizedRoomCode, playerId);
    room.players.delete(playerId);
    socket.leave(normalizedRoomCode);

    if (room.players.size === 0) {
      clearMatchTimeout(room);
      rooms.delete(normalizedRoomCode);
      io.emit('roomDeleted', { roomCode: normalizedRoomCode });
      if (typeof callback === 'function') {
        callback({ ok: true, deleted: true });
      }
      return;
    }

    if (room.hostPlayerId === playerId) {
      room.hostPlayerId = room.players.keys().next().value;
    }

    const hostPlayer = room.players.get(room.hostPlayerId);
    room.hostSocketId = hostPlayer?.socketId ?? null;
    const publicRoom = emitRoomSnapshot(normalizedRoomCode);

    if (typeof callback === 'function') {
      callback({ ok: true, room: publicRoom });
    }
  });

  socket.on('disconnect', () => {
    removePlayerFromRooms(socket.id);
  });
});

server.listen(3000, () => {
  console.log('Socket server is running on port 3000');
});
