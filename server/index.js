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

// Online players: socketId → { name, status: 'lobby'|'ingame' }
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

  const field = Array.from({ length: 30 }, () => ({
    x: 8 + Math.random() * 84,
    y: 8 + Math.random() * 84,
    rotation: Math.floor(Math.random() * 360)
  }));

  const session = new GameSession({
    roomCode,
    candy: candy._id,
    field,
    poisonedIndex: Math.floor(Math.random() * 30),
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

  // Player comes online
  socket.on('goOnline', ({ playerName }) => {
    onlinePlayers.set(socket.id, { name: playerName, status: 'lobby' });
    broadcastLobby();
    console.log(`👤 ${playerName} is online`);
  });

  // Player goes offline / closes lobby
  socket.on('goOffline', () => {
    onlinePlayers.delete(socket.id);
    broadcastLobby();
  });
cat > server/routes/game.js << 'EOF'
const express = require('express');
const router = express.Router();
const GameSession = require('../models/GameSession');
const Candy = require('../models/Candy');

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    function generateField(size = 25) {
      const positions = [];
        const minDist = 13; // minimum % distance between candy centers
          const margin = 10;
            const maxAttempts = 200;

              let placed = 0;
                let totalAttempts = 0;

                  while (placed < size && totalAttempts < maxAttempts * size) {
                      const x = margin + Math.random() * (100 - margin * 2);
                          const y = margin + Math.random() * (100 - margin * 2);
                              totalAttempts++;

                                  let overlapping = false;
                                      for (const pos of positions) {
                                            const dx = x - pos.x;
                                                  const dy = y - pos.y;
                                                        if (Math.sqrt(dx * dx + dy * dy) < minDist) {
                                                                overlapping = true;
                                                                        break;
                                                                              }
                                                                                  }

                                                                                      if (!overlapping) {
                                                                                            positions.push({
                                                                                                    x: Math.round(x * 10) / 10,
                                                                                                            y: Math.round(y * 10) / 10,
                                                                                                                    rotation: Math.floor(Math.random() * 360)
                                                                                                                          });
                                                                                                                                placed++;
                                                                                                                                    }
                                                                                                                                      }

                                                                                                                                        return positions;
                                                                                                                                        }

                                                                                                                                        router.get('/next-date', async (req, res) => {
                                                                                                                                          try {
                                                                                                                                              const lastCandy = await Candy.findOne({ scheduledDate: { $ne: null } }).sort({ scheduledDate: -1 });
                                                                                                                                                  const baseDate = lastCandy ? new Date(lastCandy.scheduledDate) : new Date();
                                                                                                                                                      baseDate.setDate(baseDate.getDate() + 1);
                                                                                                                                                          res.json({ nextDate: baseDate.toISOString().split('T')[0] });
                                                                                                                                                            } catch (err) {
                                                                                                                                                                res.status(500).json({ error: err.message });
                                                                                                                                                                  }
                                                                                                                                                                  });

                                                                                                                                                                  router.get('/queue', async (req, res) => {
                                                                                                                                                                    try {
                                                                                                                                                                        const candies = await Candy.find().sort({ queuePosition: 1 });
                                                                                                                                                                            res.json(candies);
                                                                                                                                                                              } catch (err) {
                                                                                                                                                                                  res.status(500).json({ error: err.message });
                                                                                                                                                                                    }
                                                                                                                                                                                    });

                                                                                                                                                                                    router.get('/today', async (req, res) => {
                                                                                                                                                                                      try {
                                                                                                                                                                                          const candy = await Candy.findOne({ status: 'active' });
                                                                                                                                                                                              if (!candy) return res.status(404).json({ error: 'No active candy today' });
                                                                                                                                                                                                  res.json(candy);
                                                                                                                                                                                                    } catch (err) {
                                                                                                                                                                                                        res.status(500).json({ error: err.message });
                                                                                                                                                                                                          }
                                                                                                                                                                                                          });

                                                                                                                                                                                                          router.post('/create', async (req, res) => {
                                                                                                                                                                                                            try {
                                                                                                                                                                                                                const { playerName } = req.body;
                                                                                                                                                                                                                    if (!playerName) return res.status(400).json({ error: 'Player name is required' });

                                                                                                                                                                                                                        const candy = await Candy.findOne({ status: 'active' });
                                                                                                                                                                                                                            if (!candy) return res.status(404).json({ error: 'No active candy today' });

                                                                                                                                                                                                                                let roomCode;
                                                                                                                                                                                                                                    let exists = true;
                                                                                                                                                                                                                                        while (exists) {
                                                                                                                                                                                                                                              roomCode = generateRoomCode();
                                                                                                                                                                                                                                                    exists = await GameSession.findOne({ roomCode });
                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                            const field = generateField(25);
                                                                                                                                                                                                                                                                const poisonedIndex = Math.floor(Math.random() * field.length);

                                                                                                                                                                                                                                                                    const session = new GameSession({
                                                                                                                                                                                                                                                                          roomCode,
                                                                                                                                                                                                                                                                                candy: candy._id,
                                                                                                                                                                                                                                                                                      field,
                                                                                                                                                                                                                                                                                            poisonedIndex,
                                                                                                                                                                                                                                                                                                  players: [{
                                                                                                                                                                                                                                                                                                          name: playerName,
                                                                                                                                                                                                                                                                                                                  socketId: null,
                                                                                                                                                                                                                                                                                                                          hasPicked: false,
                                                                                                                                                                                                                                                                                                                                  pickedIndex: null,
                                                                                                                                                                                                                                                                                                                                          result: 'pending'
                                                                                                                                                                                                                                                                                                                                                }],
                                                                                                                                                                                                                                                                                                                                                      status: 'waiting'
                                                                                                                                                                                                                                                                                                                                                          });

                                                                                                                                                                                                                                                                                                                                                              await session.save();

                                                                                                                                                                                                                                                                                                                                                                  res.json({
                                                                                                                                                                                                                                                                                                                                                                        success: true,
                                                                                                                                                                                                                                                                                                                                                                              roomCode,
                                                                                                                                                                                                                                                                                                                                                                                    field,
                                                                                                                                                                                                                                                                                                                                                                                          candy: {
                                                                                                                                                                                                                                                                                                                                                                                                  name: candy.name,
                                                                                                                                                                                                                                                                                                                                                                                                          imageUrl: candy.imageUrl,
                                                                                                                                                                                                                                                                                                                                                                                                                  colorPalette: candy.colorPalette
                                                                                                                                                                                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                                                                                                                                                                                            });

                                                                                                                                                                                                                                                                                                                                                                                                                              } catch (err) {
                                                                                                                                                                                                                                                                                                                                                                                                                                  console.error('Create room error:', err);
                                                                                                                                                                                                                                                                                                                                                                                                                                      res.status(500).json({ error: err.message });
                                                                                                                                                                                                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                                                                                                                                                                                                        });

                                                                                                                                                                                                                                                                                                                                                                                                                                        router.get('/:roomCode', async (req, res) => {
                                                                                                                                                                                                                                                                                                                                                                                                                                          try {
                                                                                                                                                                                                                                                                                                                                                                                                                                              const session = await GameSession.findOne({ roomCode: req.params.roomCode }).populate('candy');
                                                                                                                                                                                                                                                                                                                                                                                                                                                  if (!session) return res.status(404).json({ error: 'Room not found' });

                                                                                                                                                                                                                                                                                                                                                                                                                                                      res.json({
                                                                                                                                                                                                                                                                                                                                                                                                                                                            roomCode: session.roomCode,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                  status: session.status,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                        field: session.field,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                              fieldSize: session.fieldSize,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    players: session.players.map(p => ({ name: p.name, hasPicked: p.hasPicked })),
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          candy: {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  name: session.candy.name,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          imageUrl: session.candy.imageUrl,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  colorPalette: session.candy.colorPalette
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            });

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              } catch (err) {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  res.status(500).json({ error: err.message });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    });

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    router.post('/join', async (req, res) => {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      try {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          const { roomCode, playerName } = req.body;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              if (!roomCode || !playerName) return res.status(400).json({ error: 'Room code and player name required' });

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  const session = await GameSession.findOne({ roomCode: roomCode.toUpperCase() }).populate('candy');
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      if (!session) return res.status(404).json({ error: 'Room not found' });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          if (session.players.length >= 2) return res.status(400).json({ error: 'Room is full' });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              if (session.status !== 'waiting') return res.status(400).json({ error: 'Game already started' });

                                                                                socket.on('pickCandy', async ({ roomCode, playerName, index }) => {
                                                                                      try {
                                                                                            const GameSession = require('./models/GameSession');
                                                                                                  const session = await GameSession.findOne({ roomCode }).select('+poisonedIndex');
                                                                                                        if (!session) return;

                                                                                                              const player = session.players.find(p => p.name === playerName);
                                                                                                                    if (!player || player.hasPicked) return;

                                                                                                                          player.hasPicked = true;
                                                                                                                                player.pickedIndex = index;
                                                                                                                                      player.result = (index === session.poisonedIndex) ? 'lost' : 'won';
                                                                                                                                            await session.save();

                                                                                                                                                  const allPicked = session.players.every(p => p.hasPicked);

                                                                                                                                                        if (allPicked) {
                                                                                                                                                                session.status = 'finished';
                                                                                                                                                                        await session.save();

                                                                                                                                                                                for (const p of session.players) {
                                                                                                                                                                                          const isPoison = p.pickedIndex === session.poisonedIndex;
                                                                                                                                                                                                    io.to(p.socketId).emit('pickResult', {
                                                                                                                                                                                                                index: p.pickedIndex,
                                                                                                                                                                                                                            isPoison,
                                                                                                                                                                                                                                        result: p.result,
                                                                                                                                                                                                                                                    poisonedIndex: session.poisonedIndex
                                                                                                                                                                                                                                                              });
                                                                                                                                                                                                                                                                      }

                                                                                                                                                                                                                                                                              const [p1, p2] = session.players;
                                                                                                                                                                                                                                                                                      io.to(p1.socketId).emit('opponentPickResult', {
                                                                                                                                                                                                                                                                                                playerName: p2.name,
                                                                                                                                                                                                                                                                                                          index: p2.pickedIndex,
                                                                                                                                                                                                                                                                                                                    poisonedIndex: session.poisonedIndex
                                                                                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                                                                                                    io.to(p2.socketId).emit('opponentPickResult', {
                                                                                                                                                                                                                                                                                                                                              playerName: p1.name,
                                                                                                                                                                                                                                                                                                                                                        index: p1.pickedIndex,
                                                                                                                                                                                                                                                                                                                                                                  poisonedIndex: session.poisonedIndex
                                                                                                                                                                                                                                                                                                                                                                          });

                                                                                                                                                                                                                                                                                                                                                                                  console.log(`🎮 Both picked — game finished in room ${roomCode}`);
                                                                                                                                                                                                                                                                                                                                                                                        } else {
                                                                                                                                                                                                                                                                                                                                                                                                console.log(`${playerName} picked ${index} — waiting for opponent in ${roomCode}`);
                                                                                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                                                                                          } catch (err) {
                                                                                                                                                                                                                                                                                                                                                                                                                console.error('Pick error:', err);
                                                                                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                                                                                      });
                                                                                })                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  session.players.push({
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        name: playerName,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              socketId: null,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    hasPicked: false,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          pickedIndex: null,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                result: 'pending'
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    });

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        session.status = 'in_progress';
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            await session.save();

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                res.json({
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      success: true,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            roomCode: session.roomCode,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  field: session.field,
                        þ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                candy: {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                name: session.candy.name,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        imageUrl: session.candy.imageUrl,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                colorPalette: session.candy.colorPalette
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          });

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            } catch (err) {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                res.status(500).json({ error: err.message });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  });

                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  module.exports = router;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  EOF
  // Join a game room (for field sync)
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    socket.join(roomCode);
    socket.to(roomCode).emit('opponentJoined', { playerName });
    if (onlinePlayers.has(socket.id)) {
      onlinePlayers.get(socket.id).status = 'ingame';
      broadcastLobby();
    }
  });

  // Matchmaking with stranger
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

  // Lobby invite system
  socket.on('sendInvite', ({ toSocketId, fromName }) => {
    io.to(toSocketId).emit('inviteReceived', {
      fromSocketId: socket.id,
      fromName
    });
    console.log(`📨 ${fromName} invited ${toSocketId}`);
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
      console.log(`🎮 Lobby match: ${opponent.name} vs ${playerName} → ${roomCode}`);
    } catch (err) {
      socket.emit('inviteError', { error: err.message });
    }
  });

  socket.on('declineInvite', ({ fromSocketId, playerName }) => {
    io.to(fromSocketId).emit('inviteDeclined', { byName: playerName });
  });

  // Cancel pending invite
  socket.on('cancelInvite', ({ toSocketId }) => {
    io.to(toSocketId).emit('inviteCancelled');
  });

  // Pick candy — relay to opponent
  socket.on('pickCandy', ({ roomCode, playerName, index }) => {
    socket.to(roomCode).emit('opponentPicked', { playerName, index });
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
