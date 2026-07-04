const mongoose = require('mongoose');

const gameSessionSchema = new mongoose.Schema({
  roomCode: {
    type: String,
    required: true,
    unique: true
  },
  candy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Candy',
    required: true
  },
  fieldSize: { type: Number, default: 25 },
  field: {
    type: [{ x: Number, y: Number, rotation: Number }],
    default: []
  },
  poisonedCandies: {
    type: [{ playerIndex: Number, candyIndex: Number }],
    default: [],
    select: false
  },
  readyPlayers: {
    type: [Number],
    default: []
  },
  gamePhase: {
    type: String,
    enum: ['setup', 'playing', 'finished'],
    default: 'setup'
  },
  takenCandies: {
    type: [Number],
    default: []
  },
  currentTurn: {
    type: Number,
    default: 0
  },
  players: {
    type: [
      {
        socketId: String,
        name: String,
        result: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' }
      }
    ],
    default: []
  },
  status: {
    type: String,
    enum: ['waiting', 'in_progress', 'finished'],
    default: 'waiting'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400
  }
});

module.exports = mongoose.model('GameSession', gameSessionSchema);
