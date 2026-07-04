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
  const margin = 14;
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
