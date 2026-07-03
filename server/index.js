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

  const field = Array.from({ length: 25 }, () => ({
    x: 10 + Math.random() * 80,
    y: 10 + Math.random() * 80,
    rotation: Math.floor(Math.random() * 360)
  }));

  const session = new GameSession({
    roomCode,
    candy: candy._id,
    field,
    poisonedIndex: Math.floor(Math.random() * 25),
    players: [
      { name: player1.name, socketId: player1.socketId, hasPicked: false, pickedIndex: null, result: 'pending' },
      { name: player2.name, socketId: player2.socketId, hasPicked: false, pickedIndex: null, result: 'pending' }
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

    // Update socketId in DB
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
      console.error('joinRoom socketId update error:', err);
    }

    if (onlinePlayers.has(socket.id)) {
      onlinePlayers.get(socket.id).status = 'ingame';
      broadcastLobby();
    }
    console.log(`${playerName} joined room ${roomCode}`);
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
        console.error('Matchmaking error:', err.message);
        socket.emit('matchError', { error: err.message });
      }
    } else {
      matchmakingQueue.push({ socketId: socket.id, playerName });
      console.log(`⏳ ${playerName} queued for matchmaking`);
    }
  });

  socket.on('leaveMatchmaking', () => {
    const i = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (i !== -1) matchmakingQueue.splice(i, 1);
  });

  socket.on('sendInvite', ({ toSocketId, fromName }) => {
    io.to(toSocketId).emit('inviteReceived', {
      fromSocketId: socket.id,
      fromName
    });
  });

  socket.on('acceptInvite', async ({ fromSocketId, playerName }) => {
    try {
      const opponent = onlinePlayers.get(fromSocketId);
      if (!opponent) {
        socket.emit('inviteError', { error: 'Player went offline' });
        return;
      }
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

  socket.on('pickCandy', async ({ roomCode, playerName, index }) => {
    try {
      const GameSession = require('./models/GameSession');
      const session = await GameSession.findOne({ roomCode }).select('+poisonedIndex');
      if (!session) return;

      // Check if it's this player's turn
      const playerIndex = session.players.findIndex(p => p.name === playerName);
      if (playerIndex !== session.currentTurn) {
        socket.emit('notYourTurn');
        return;
      }

      // Check if candy already taken
      if (session.takenCandies && session.takenCandies.includes(index)) {
        socket.emit('alreadyTaken');
        return;
      }

      // Add to taken candies
      if (!session.takenCandies) session.takenCandies = [];
      session.takenCandies.push(index);

      const isPoison = index === session.poisonedIndex;

      if (isPoison) {
        // Game over — picker loses
        session.status = 'finished';
        session.players[playerIndex].result = 'lost';
        session.players[1 - playerIndex].result = 'won';
        await session.save();

        // Notify both players
        io.to(roomCode).emit('candyTaken', {
          playerName,
          index,
          isPoison: true,
          takenCandies: session.takenCandies
        });

        // Send results after short delay for animation
        setTimeout(() => {
          for (const p of session.players) {
            io.to(p.socketId).emit('gameOver', {
              result: p.result,
              poisonedIndex: session.poisonedIndex,
              loserName: playerName
            });
          }
        }, 1500);

        console.log(`☠️ ${playerName} picked poison in room ${roomCode}`);
      } else {
        // Safe pick — switch turn
        session.currentTurn = 1 - session.currentTurn;
        await session.save();

        io.to(roomCode).emit('candyTaken', {
          playerName,
          index,
          isPoison: false,
          takenCandies: session.takenCandies,
          nextTurn: session.players[session.currentTurn].name
        });

        console.log(`✅ ${playerName} safely picked ${index} in ${roomCode} — next: ${session.players[session.currentTurn].name}`);
      }
    } catch (err) {
      console.error('Pick error:', err);
    }
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
