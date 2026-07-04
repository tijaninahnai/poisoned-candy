require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
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

const onlinePlayers = new Map();
const matchmakingQueue = [];

function broadcastLobby() {
  const players = Array.from(onlinePlayers.entries()).map(([id, p]) => ({
    socketId: id,
    name: p.name,
    status: p.status
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

  // Generate non-overlapping field
  const positions = [];
  const minDist = 13;
  const margin = 10;
  let attempts = 0;
  while (positions.length < 25 && attempts < 5000) {
    attempts++;
    const x = margin + Math.random() * (100 - margin * 2);
    const y = margin + Math.random() * (100 - margin * 2);
    const overlapping = positions.some(p => {
      const dx = x - p.x, dy = y - p.y;
      return Math.sqrt(dx*dx + dy*dy) < minDist;
    });
    if (!overlapping) positions.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      rotation: Math.floor(Math.random() * 360)
    });
  }

  const session = new GameSession({
    roomCode,
    candy: candy._id,
    field: positions,
    poisonedCandies: [],
    readyPlayers: [],
    gamePhase: 'setup',
    players: [
      { name: player1.name, socketId: player1.socketId, result: 'pending' },
      { name: player2.name, socketId: player2.socketId, result: 'pending' }
    ],
    status: 'in_progress'
  });

  await session.save();
  return { roomCode, session };
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
        if (player) {
          player.socketId = socket.id;
          await session.save();
        }
      }
    } catch (err) {
      console.error('joinRoom error:', err);
    }

    if (onlinePlayers.has(socket.id)) {
      onlinePlayers.get(socket.id).status = 'ingame';
      broadcastLobby();
    }
  });

  // SETUP PHASE: player secretly selects their poison candy
  socket.on('setPoisonCandy', async ({ roomCode, playerName, candyIndex }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || session.gamePhase !== 'setup') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex === -1) return;

      // Remove existing choice for this player if any
      session.poisonedCandies = session.poisonedCandies.filter(p => p.playerIndex !== playerIndex);
      session.poisonedCandies.push({ playerIndex, candyIndex });
      await session.save();

      // Confirm back to this player only (not broadcast)
      socket.emit('poisonSet', { candyIndex });
      console.log(`☠️ ${playerName} secretly poisoned candy ${candyIndex} in ${roomCode}`);
    } catch (err) {
      console.error('setPoisonCandy error:', err);
    }
  });

  // SETUP PHASE: player clicks Ready
  socket.on('playerReady', async ({ roomCode, playerName }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || session.gamePhase !== 'setup') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex === -1) return;

      // Must have chosen a poison candy first
      const hasChosen = session.poisonedCandies.some(p => p.playerIndex === playerIndex);
      if (!hasChosen) {
        socket.emit('readyError', { error: 'Choose a candy to poison first!' });
        return;
      }

      // Add to ready list if not already
      if (!session.readyPlayers.includes(playerIndex)) {
        session.readyPlayers.push(playerIndex);
      }

      // Tell both players how many are ready
      io.to(roomCode).emit('readyUpdate', {
        readyCount: session.readyPlayers.length,
        readyPlayers: session.readyPlayers
      });

      // Both ready → start game
      if (session.readyPlayers.length === 2) {
        session.gamePhase = 'playing';
        await session.save();

        io.to(roomCode).emit('gameStart', {
          firstTurn: session.players[0].name
        });
        console.log(`🎮 Both ready — game started in ${roomCode}`);
      } else {
        await session.save();
        console.log(`⏳ ${playerName} is ready in ${roomCode} — waiting for opponent`);
      }
    } catch (err) {
      console.error('playerReady error:', err);
    }
  });

  // GAME PHASE: player picks a candy
  socket.on('pickCandy', async ({ roomCode, playerName, index }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedCandies');
      if (!session || session.gamePhase !== 'playing') return;

      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex !== session.currentTurn) {
        socket.emit('notYourTurn');
        return;
      }

      if (session.takenCandies.includes(index)) return;

      session.takenCandies.push(index);

      // Check if this candy is poisoned (by either player)
      const poisonEntry = session.poisonedCandies.find(p => p.candyIndex === index);

      if (poisonEntry) {
        // Poisoned — picker loses regardless of who poisoned it
        session.gamePhase = 'finished';
        session.status = 'finished';
        session.players[playerIndex].result = 'lost';
        session.players[1 - playerIndex].result = 'won';
        await session.save();

        // Tell both who poisoned it (for reveal)
        io.to(roomCode).emit('candyTaken', {
          playerName,
          index,
          isPoison: true,
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

        console.log(`☠️ ${playerName} picked poison (by ${session.players[poisonEntry.playerIndex].name}) in ${roomCode}`);
      } else {
        // Safe — switch turn
        session.currentTurn = 1 - session.currentTurn;
        await session.save();

        io.to(roomCode).emit('candyTaken', {
          playerName,
          index,
          isPoison: false,
          takenCandies: session.takenCandies,
          nextTurn: session.players[session.currentTurn].name
        });

        console.log(`✅ ${playerName} safely picked ${index} in ${roomCode}`);
      }
    } catch (err) {
      console.error('pickCandy error:', err);
    }
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
    } catch (err) {
      socket.emit('inviteError', { error: err.message });
    }
  });

  socket.on('declineInvite', ({ fromSocketId, playerName }) => {
    io.to(fromSocketId).emit('inviteDeclined', { byName: playerName });
  });

  socket.on('cancelInvite', ({ toSocketId }) => {
    io.to(toSocketId).emit('inviteCancelled');
  });

  socket.on('matchFound', ({ roomCode }) => {
    socket.emit('matchFound', { roomCode });
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
