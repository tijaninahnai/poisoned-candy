const express = require('express');
const router = express.Router();
const GameSession = require('../models/GameSession');
const Candy = require('../models/Candy');

// Genereer een random 5-letter room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Genereer het speelveld — random posities voor N candies
function generateField(size = 30) {
  const positions = [];
  const margin = 8; // % marge van de randen

  for (let i = 0; i < size; i++) {
    let x, y, overlapping;
    let attempts = 0;

    do {
      overlapping = false;
      x = margin + Math.random() * (100 - margin * 2);
      y = margin + Math.random() * (100 - margin * 2);

      // Vermijd overlap met bestaande candies
      for (const pos of positions) {
        const dx = x - pos.x;
        const dy = y - pos.y;
        if (Math.sqrt(dx * dx + dy * dy) < 10) {
          overlapping = true;
          break;
        }
      }
      attempts++;
    } while (overlapping && attempts < 50);

    positions.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      rotation: Math.floor(Math.random() * 360)
    });
  }

  return positions;
}

// POST /api/game/create — maak een nieuwe room aan
router.post('/create', async (req, res) => {
  try {
    const { playerName } = req.body;
    if (!playerName) return res.status(400).json({ error: 'Player name is required' });

    // Haal de actieve candy op
    const candy = await Candy.findOne({ status: 'active' });
    if (!candy) return res.status(404).json({ error: 'No active candy today — host must activate one first' });

    // Genereer unieke room code
    let roomCode;
    let exists = true;
    while (exists) {
      roomCode = generateRoomCode();
      exists = await GameSession.findOne({ roomCode });
    }

    const field = generateField(30);
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

// GET /api/game/:roomCode — haal room info op
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

// POST /api/game/join — join een bestaande room
router.post('/join', async (req, res) => {
  try {
    const { roomCode, playerName } = req.body;
    if (!roomCode || !playerName) return res.status(400).json({ error: 'Room code and player name are required' });

    const session = await GameSession.findOne({ roomCode: roomCode.toUpperCase() }).populate('candy');
    if (!session) return res.status(404).json({ error: 'Room not found' });
    if (session.players.length >= 2) return res.status(400).json({ error: 'Room is full' });
    if (session.status !== 'waiting') return res.status(400).json({ error: 'Game already started' });

    session.players.push({
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

module.exports = router;
