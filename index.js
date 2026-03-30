// server.js
require("dotenv").config();
const express = require('express');
const cors = require('cors');
const http = require('http'); // ✅ ใช้ http ธรรมดา
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: '*' })); // CORS แบบง่าย
app.use(express.json());

const server = http.createServer(app);

// ================= Socket.IO =================
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  },
});

// ================= Room & Match Management =================
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = '123456789';
const MAX_ROOM_GENERATION_ATTEMPTS = 2000;
const DEFAULT_MATCH_DURATION_SECONDS = 5 * 60;

const rooms = new Map();

// --- Helper Functions ---
function generateRoomCode() {
  for (let attempt = 0; attempt < MAX_ROOM_GENERATION_ATTEMPTS; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const index = Math.floor(Math.random() * ROOM_CODE_CHARS.length);
      code += ROOM_CODE_CHARS[index];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to generate unique room code.');
}

function generatePlayerId() {
  return crypto.randomUUID();
}

function normalizeRoomCode(code) {
  return String(code || '').trim().toUpperCase();
}

function normalizeDurationSeconds(value) {
  if (!value) return DEFAULT_MATCH_DURATION_SECONDS;
  const n = Number(value);
  return n > 0 ? Math.round(n) : DEFAULT_MATCH_DURATION_SECONDS;
}

function createPlayer(name, fallbackName) {
  return {
    name: name?.trim() || fallbackName,
    joinedAt: new Date().toISOString(),
    socketId: null,
  };
}

function getRoomEntity(roomCode) {
  return rooms.get(roomCode) || null;
}

function getPlayer(roomCode, playerId) {
  const room = getRoomEntity(roomCode);
  return room?.players.get(playerId) || null;
}

function clearMatchTimeout(room) {
  if (room.currentMatchTimeout) {
    clearTimeout(room.currentMatchTimeout);
    room.currentMatchTimeout = null;
  }
}

// ================= Public Room/Match Data =================
function getParticipantSnapshot(room) {
  if (!room.currentMatch) return [];
  return Array.from(room.currentMatch.playerNames.entries()).map(([pid, name]) => ({
    playerId: pid,
    name,
    score: room.currentMatch.scores.get(pid) ?? 0,
    status: room.currentMatch.playerStatuses.get(pid) ?? 'playing',
  }));
}

function buildMatchResult(room) {
  if (!room.currentMatch) return null;
  const standings = getParticipantSnapshot(room)
    .sort((a, b) => b.score - a.score)
    .map((entry, idx) => ({ ...entry, place: idx + 1 }));
  return { winnerPlayerId: standings[0]?.playerId || null, standings };
}

function getPublicMatch(room) {
  if (!room.currentMatch) return null;
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
  if (!room) return null;

  return {
    roomCode,
    hostSocketId: room.hostSocketId,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.players.size,
    players: Array.from(room.players).map(([pid, p]) => ({
      playerId: pid,
      socketId: p.socketId || null,
      name: p.name,
      joinedAt: p.joinedAt,
      isHost: pid === room.hostPlayerId,
    })),
    matchDurationSeconds: room.matchDurationSeconds,
    currentMatch: getPublicMatch(room),
  };
}

function emitRoomSnapshot(roomCode) {
  const publicRoom = getPublicRoom(roomCode);
  if (!publicRoom) return null;
  io.to(roomCode).emit('roomUpdated', publicRoom);
  return publicRoom;
}

// ================= Room / Match Logic =================
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

  return { roomCode, playerId, room: getPublicRoom(roomCode) };
}

function joinRoomForPlayer(roomCode, name) {
  const code = normalizeRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) return { ok: false, status: 404, message: 'Room not found' };

  const playerId = generatePlayerId();
  room.players.set(playerId, createPlayer(name, 'Guest'));
  return { ok: true, roomCode: code, playerId, room: getPublicRoom(code) };
}

function attachSocketToPlayer(socket, roomCode, playerId) {
  const room = getRoomEntity(roomCode);
  const player = getPlayer(roomCode, playerId);
  if (!room || !player) return { ok: false, message: 'Room or player not found' };

  player.socketId = socket.id;
  if (room.hostPlayerId === playerId) room.hostSocketId = socket.id;
  socket.join(roomCode);
  return { ok: true, room: getPublicRoom(roomCode) };
}

// ================= Socket Event Handlers =================
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ name, durationSeconds } = {}, callback) => {
    const result = createRoomForPlayer(name, normalizeDurationSeconds(durationSeconds));
    attachSocketToPlayer(socket, result.roomCode, result.playerId);
    emitRoomSnapshot(result.roomCode);
    if (callback) callback({ ok: true, ...result });
  });

  socket.on('joinRoom', ({ roomCode, name } = {}, callback) => {
    const result = joinRoomForPlayer(roomCode, name);
    if (!result.ok) {
      if (callback) callback({ ok: false, message: result.message });
      return;
    }
    attachSocketToPlayer(socket, result.roomCode, result.playerId);
    emitRoomSnapshot(result.roomCode);
    if (callback) callback({ ok: true, ...result });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // TODO: handle removing player from rooms
  });
});

// ================= Express Routes =================
app.get('/', (req, res) => res.send('Block socket server is running'));

// ================= Start Server =================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Socket server is running on port ${PORT}`);
});