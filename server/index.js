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

const matchmakingQueue = [];

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    socket.join(roomCode);
    socket.to(roomCode).emit('opponentJoined', { playerName });
    console.log(`${playerName} joined room ${roomCode}`);
  });

  socket.on('joinMatchmaking', async ({ playerName }) => {
    const existing = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (existing !== -1) matchmakingQueue.splice(existing, 1);

    if (matchmakingQueue.length > 0) {
      const opponent = matchmakingQueue.shift();

      try {
        const Candy = require('./models/Candy');
        const GameSession = require('./models/GameSession');

        const candy = await Candy.findOne({ status: 'active' });
        if (!candy) {
          socket.emit('matchError', { error: 'No active candy today' });
          return;
        }

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const roomCode = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

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
            { name: opponent.playerName, socketId: opponent.socketId, hasPicked: false, pickedIndex: null, result: 'pending' },
            { name: playerName, socketId: socket.id, hasPicked: false, pickedIndex: null, result: 'pending' }
          ],
          status: 'in_progress'
        });

        await session.save();

        io.to(opponent.socketId).emit('matchFound', { roomCode });
        socket.emit('matchFound', { roomCode });

        console.log(`🎮 Match: ${opponent.playerName} vs ${playerName} → room ${roomCode}`);
      } catch (err) {
        console.error('Matchmaking error:', err);
      }

    } else {
      matchmakingQueue.push({ socketId: socket.id, playerName });
      console.log(`⏳ ${playerName} in matchmaking queue`);
    }
  });

  socket.on('leaveMatchmaking', () => {
    const i = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (i !== -1) matchmakingQueue.splice(i, 1);
  });

  socket.on('pickCandy', ({ roomCode, playerName, index }) => {
    socket.to(roomCode).emit('opponentPicked', { playerName, index });
  });

  socket.on('disconnect', () => {
    const i = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (i !== -1) matchmakingQueue.splice(i, 1);
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍬 Poisoned Candy server running on port ${PORT}`);
});
