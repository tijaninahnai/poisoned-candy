require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    rotateCandyIfNeeded();
  })
  .catch((err) => console.error('❌ MongoDB connection error:', err));

const candyRoutes = require('./routes/candy');
const gameRoutes = require('./routes/game');

app.use('/api/candy', candyRoutes);
app.use('/api/game', gameRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'host.html')));
app.get('/game/:roomCode', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'game.html')));

app.set('io', io);

async function rotateCandyIfNeeded() {
  try {
    const Candy = require('./models/Candy');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const active = await Candy.findOne({ status: 'active' });

    if (active && active.usedOnDate) {
      const usedDate = new Date(active.usedOnDate);
      usedDate.setHours(0, 0, 0, 0);
      if (usedDate.getTime() === today.getTime()) {
        console.log(`🍬 Today's candy: ${active.name}`);
        return;
      }
    }

    if (active) {
      active.status = 'used';
      await active.save();
    }

    const next = await Candy.findOne({ status: 'queued' }).sort({ queuePosition: 1 });

    if (next) {
      next.status = 'active';
      next.usedOnDate = new Date();
      await next.save();
      console.log(`🍬 New active candy: ${next.name}`);
    } else {
      console.log('⚠️ No queued candy found');
    }
  } catch (err) {
    console.error('Candy rotation error:', err);
  }
}

cron.schedule('0 0 * * *', () => {
  console.log('🕛 Running daily candy rotation...');
  rotateCandyIfNeeded();
});

const onlinePlayers = new Map();
const matchmakingQueue = [];

function broadcastLobby() {
  const players = Array.from(onlinePlayers.entries()).map(([id, p]) => ({
    socketId: id, name: p.name, status: p.status
  }));
  io.emit('lobbyUpdate', players);
}

async function createGameSession(player1, player2) {
  const Candy = require('./models/Candy');
  const GameSession = require('./models/GameSession');

  const candy = await Candy.findOne({ status: 'active' });
  if (!candy) throw new Error('No active candy today');

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const roomCode = Array.from({ length: 5 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');

  const cols = 5, rows = 4;
  const colStep = 100 / (cols + 1);
  const rowStep = 100 / (rows + 1);
  const field = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      field.push({
        x: Math.round((colStep * (c + 1) + (Math.random() - 0.5) * 4) * 10) / 10,
        y: Math.round((rowStep * (r + 1) + (Math.random() - 0.5) * 4) * 10) / 10,
        rotation: Math.floor(Math.random() * 360)
      });
    }
  }

  const session = new GameSession({
    roomCode, candy: candy._id, field,
    poisonedCandies: [], readyPlayers: [],
    gamePhase: 'setup', isSolo: false,
    players: [
      { name: player1.name, socketId: player1.socketId, result: 'pending' },
      { name: player2.name, socketId: player2.socketId, result: 'pending' }
    ],
    status: 'in_progress'
  });

  await session.save();
  return { roomCode, session };
}

async function triggerCpuPick(roomCode) {
  try {
    const GameSession = require('./models/GameSession');
    const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
    if (!session || session.gamePhase !== 'playing' || session.currentTurn !== 1) return;

    const fieldSize = session.field.length;
    const cpuPoison = session.poisonedCandies.find(p => p.playerIndex === 1);
    const cpuPoisonIndex = cpuPoison ? cpuPoison.candyIndex : -1;

    const available = Array.from({ length: fieldSize }, (_, i) => i)
      .filter(i => !session.takenCandies.includes(i) && i !== cpuPoisonIndex);

    if (available.length === 0) return;

    const picked = available[Math.floor(Math.random() * available.length)];
    session.takenCandies.push(picked);

    const poisonEntry = session.poisonedCandies.find(p => p.candyIndex === picked);

    if (poisonEntry) {
      session.gamePhase = 'finished';
      session.status = 'finished';
      session.players[1].result = 'lost';
      session.players[0].result = 'won';
      await session.save();

      io.to(roomCode).emit('candyTaken', {
        playerName: 'CPU', index: picked, isPoison: true,
        takenCandies: session.takenCandies,
        poisonedBy: session.players[poisonEntry.playerIndex].name
      });

      setTimeout(() => {
        io.to(roomCode).emit('gameOver', {
          result: 'won',
          poisonedCandies: session.poisonedCandies,
          loserName: 'CPU',
          poisonedBy: session.players[poisonEntry.playerIndex].name
        });
      }, 1500);

    } else {
      session.currentTurn = 0;
      await session.save();

      io.to(roomCode).emit('candyTaken', {
        playerName: 'CPU', index: picked, isPoison: false,
        takenCandies: session.takenCandies,
        nextTurn: session.players[0].name
      });
    }
  } catch (err) {
    console.error('CPU pick error:', err);
  }
}

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('goOnline', ({ playerName }) => {
    onlinePlayers.set(socket.id, { name: playerName, status: 'lobby' });
    broadcastLobby();
  });

  socket.on('goOffline', () => {
    onlinePlayers.delete(socket.id);
    broadcastLobby();
  });

  socket.on('joinRoom', async ({ roomCode, playerName }) => {
    socket.join(roomCode);
    socket.to(roomCode).emit('opponentJoined', { playerName });
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode });
      if (session) {
        const player = session.players.find(p => p.name === playerName);
        if (player) { player.socketId = socket.id; await session.save(); }
      }
    } catch (err) { console.error('joinRoom error:', err); }

    if (onlinePlayers.has(socket.id)) {
      onlinePlayers.get(socket.id).status = 'ingame';
      broadcastLobby();
    }
  });

  socket.on('setPoisonCandy', async ({ roomCode, playerName, candyIndex }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || session.gamePhase !== 'setup') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex === -1) return;

      session.poisonedCandies = session.poisonedCandies.filter(p => p.playerIndex !== playerIndex);
      session.poisonedCandies.push({ playerIndex, candyIndex });
      await session.save();

      socket.emit('poisonSet', { candyIndex });
      console.log(`☠️ ${playerName} poisoned candy ${candyIndex} in ${roomCode}`);
    } catch (err) { console.error('setPoisonCandy error:', err); }
  });

  socket.on('playerReady', async ({ roomCode, playerName }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || session.gamePhase !== 'setup') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex === -1) return;

      const hasChosen = session.poisonedCandies.some(p => p.playerIndex === playerIndex);
      if (!hasChosen) { socket.emit('readyError', { error: 'Choose a candy to poison first!' }); return; }

      if (!session.readyPlayers.includes(playerIndex)) session.readyPlayers.push(playerIndex);

      io.to(roomCode).emit('readyUpdate', {
        readyCount: session.readyPlayers.length,
        readyPlayers: session.readyPlayers
      });

      if (session.readyPlayers.length === 2) {
        session.gamePhase = 'playing';
        session.currentTurn = 0;
        await session.save();
        io.to(roomCode).emit('gameStart', { firstTurn: session.players[0].name });
        console.log(`🎮 Multiplayer game started in ${roomCode}`);
      } else {
        await session.save();
      }
    } catch (err) { console.error('playerReady error:', err); }
  });

  socket.on('soloReady', async ({ roomCode, playerName }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || !session.isSolo || session.gamePhase !== 'setup') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex === -1) return;

      const hasChosen = session.poisonedCandies.some(p => p.playerIndex === playerIndex);
      if (!hasChosen) {
        socket.emit('readyError', { error: 'Choose a candy to poison first!' });
        return;
      }

      session.players[playerIndex].socketId = socket.id;
      session.gamePhase = 'playing';
      session.currentTurn = Math.random() > 0.5 ? 0 : 1;
      await session.save();

      socket.emit('gameStart', {
        firstTurn: session.players[session.currentTurn].name,
        isSolo: true
      });

      console.log(`🤖 Solo started in ${roomCode} — first: ${session.players[session.currentTurn].name}`);

      if (session.currentTurn === 1) {
        setTimeout(() => triggerCpuPick(roomCode), 2000);
      }
    } catch (err) { console.error('soloReady error:', err); }
  });

  socket.on('pickCandy', async ({ roomCode, playerName, index }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || session.gamePhase !== 'playing') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex !== session.currentTurn) { socket.emit('notYourTurn'); return; }
      if (session.takenCandies.includes(index)) return;

      session.takenCandies.push(index);
      const poisonEntry = session.poisonedCandies.find(p => p.candyIndex === index);

      if (poisonEntry) {
        session.gamePhase = 'finished';
        session.status = 'finished';
        session.players[playerIndex].result = 'lost';
        session.players[1 - playerIndex].result = 'won';
        await session.save();

        io.to(roomCode).emit('candyTaken', {
          playerName, index, isPoison: true,
          takenCandies: session.takenCandies,
          poisonedBy: session.players[poisonEntry.playerIndex].name
        });

        setTimeout(() => {
          for (const p of session.players) {
            io.to(p.socketId).emit('gameOver', {
              result: p.result,
              poisonedCandies: session.poisonedCandies,
              loserName: playerName,
              poisonedBy: session.players[poisonEntry.playerIndex].name
            });
          }
        }, 1500);

      } else {
        session.currentTurn = 1 - session.currentTurn;
        await session.save();

        io.to(roomCode).emit('candyTaken', {
          playerName, index, isPoison: false,
          takenCandies: session.takenCandies,
          nextTurn: session.players[session.currentTurn].name
        });
      }
    } catch (err) { console.error('pickCandy error:', err); }
  });

  socket.on('soloPickCandy', async ({ roomCode, playerName, index }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || !session.isSolo || session.gamePhase !== 'playing') return;
      if (session.currentTurn !== 0) { socket.emit('notYourTurn'); return; }
      if (session.takenCandies.includes(index)) return;

      session.takenCandies.push(index);
      const poisonEntry = session.poisonedCandies.find(p => p.candyIndex === index);

      if (poisonEntry) {
        session.gamePhase = 'finished';
        session.status = 'finished';
        session.players[0].result = 'lost';
        session.players[1].result = 'won';
        await session.save();

        socket.emit('candyTaken', {
          playerName, index, isPoison: true,
          takenCandies: session.takenCandies,
          poisonedBy: session.players[poisonEntry.playerIndex].name
        });

        setTimeout(() => {
          socket.emit('gameOver', {
            result: 'lost',
            poisonedCandies: session.poisonedCandies,
            loserName: playerName,
            poisonedBy: session.players[poisonEntry.playerIndex].name
          });
        }, 1500);

      } else {
        session.currentTurn = 1;
        await session.save();

        socket.emit('candyTaken', {
          playerName, index, isPoison: false,
          takenCandies: session.takenCandies,
          nextTurn: 'CPU'
        });

        setTimeout(() => triggerCpuPick(roomCode), 1800);
      }
    } catch (err) { console.error('soloPickCandy error:', err); }
  });

  socket.on('joinMatchmaking', async ({ playerName }) => {
    const existing = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (existing !== -1) matchmakingQueue.splice(existing, 1);

    if (matchmakingQueue.length > 0) {
      const opponent = matchmakingQueue.shift();
      try {
        const { roomCode } = await createGameSession(
          { name: opponent.playerName, socketId: opponent.socketId },
          { name: playerName, socketId: socket.id }
        );
        io.to(opponent.socketId).emit('matchFound', { roomCode });
        socket.emit('matchFound', { roomCode });
        console.log(`🎮 Match: ${opponent.playerName} vs ${playerName} → ${roomCode}`);
      } catch (err) {
        socket.emit('matchError', { error: err.message });
      }
    } else {
      matchmakingQueue.push({ socketId: socket.id, playerName });
      console.log(`⏳ ${playerName} queued`);
    }
  });

  socket.on('leaveMatchmaking', () => {
    const i = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (i !== -1) matchmakingQueue.splice(i, 1);
  });

  socket.on('sendInvite', ({ toSocketId, fromName }) => {
    io.to(toSocketId).emit('inviteReceived', { fromSocketId: socket.id, fromName });
  });

  socket.on('acceptInvite', async ({ fromSocketId, playerName }) => {
    try {
      const opponent = onlinePlayers.get(fromSocketId);
      if (!opponent) { socket.emit('inviteError', { error: 'Player went offline' }); return; }
      const { roomCode } = await createGameSession(
        { name: opponent.name, socketId: fromSocketId },
        { name: playerName, socketId: socket.id }
      );
      io.to(fromSocketId).emit('matchFound', { roomCode });
      socket.emit('matchFound', { roomCode });
    } catch (err) { socket.emit('inviteError', { error: err.message }); }
  });

  socket.on('declineInvite', ({ fromSocketId, playerName }) => {
    io.to(fromSocketId).emit('inviteDeclined', { byName: playerName });
  });

  socket.on('cancelInvite', ({ toSocketId }) => {
    io.to(toSocketId).emit('inviteCancelled');
  });

  socket.on('disconnect', () => {
    const i = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (i !== -1) matchmakingQueue.splice(i, 1);
    onlinePlayers.delete(socket.id);
    broadcastLobby();
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍬 Poisoned Candy server running on port ${PORT}`);
});
