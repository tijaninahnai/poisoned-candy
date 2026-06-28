// server/index.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.IO setup — CORS open for now, tighten this once you know your final frontend URL
const io = new Server(server, {
  cors: {
      origin: '*',
          methods: ['GET', 'POST']
            }
            });

            // Middleware
            app.use(cors());
            app.use(express.json());
            app.use(express.static(path.join(__dirname, '..', 'public')));

            // MongoDB connection
            mongoose.connect(process.env.MONGODB_URI)
              .then(() => console.log('✅ MongoDB connected'))
                .catch((err) => console.error('❌ MongoDB connection error:', err));

                // Routes (built out in Step 4 and Step 5)
                const candyRoutes = require('./routes/candy');
                const gameRoutes = require('./routes/game');

                app.use('/api/candy', candyRoutes);
                app.use('/api/game', gameRoutes);

                // Basic page routes
                app.get('/', (req, res) => {
                  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
                  });

                  app.get('/host', (req, res) => {
                    res.sendFile(path.join(__dirname, '..', 'public', 'host.html'));
                    });

                    app.get('/game/:roomCode', (req, res) => {
                      res.sendFile(path.join(__dirname, '..', 'public', 'game.html'));
                      });

                      // Socket.IO connection handling — room logic comes in Step 6
                      io.on('connection', (socket) => {
                        console.log(`🔌 Player connected: ${socket.id}`);

                          socket.on('disconnect', () => {
                              console.log(`🔌 Player disconnected: ${socket.id}`);
                                });
                                });

                                // Make io accessible inside route files (candy.js, game.js) via req.app.get('io')
                                app.set('io', io);

                                const PORT = process.env.PORT || 3000;
                                server.listen(PORT, () => {
                                  console.log(`🍬 Poisoned Candy server running on port ${PORT}`);
                                  });