const mongoose = require('mongoose');

const candySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  imageUrl: {
    type: String,
    required: true
  },
  cloudinaryId: {
    type: String,
    required: true
  },
  colorPalette: {
    type: [String],
    default: []
  },
  queuePosition: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['queued', 'active', 'used'],
    default: 'queued'
  },
  usedOnDate: {
    type: Date,
    default: null
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Candy', candySchema);
