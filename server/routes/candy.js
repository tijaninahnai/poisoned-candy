const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const Candy = require('../models/Candy');

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer storage → direct naar Cloudinary
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'poisoned-candy',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 400, height: 400, crop: 'pad', background: 'white' }]
  }
});

const upload = multer({ storage });

// POST /api/candy/upload
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const { name, scheduledDate } = req.body;

    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!name) return res.status(400).json({ error: 'Candy name is required' });

    // Extract dominant colors from the uploaded image via Cloudinary
    let palette = ['#ff6b81', '#ffffff', '#c0392b'];
    try {
      const colorData = await cloudinary.api.resource(req.file.filename, {
        colors: true
      });
      if (colorData.colors) {
        palette = colorData.colors.slice(0, 5).map(c => c[0]);
      }
    } catch (colorErr) {
      console.error('Color extraction failed (using fallback palette):', colorErr.message);
    }
    // Find next queue position
    const lastCandy = await Candy.findOne().sort({ queuePosition: -1 });
    const nextPosition = lastCandy ? lastCandy.queuePosition + 1 : 1;

    // Save to MongoDB
    const candy = new Candy({
      name,
      imageUrl: req.file.path,
      cloudinaryId: req.file.filename,
      colorPalette: palette,
      queuePosition: nextPosition,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      status: 'queued'
    });

    await candy.save();

    res.json({
      success: true,
      candy: {
        id: candy._id,
        name: candy.name,
        imageUrl: candy.imageUrl,
        colorPalette: candy.colorPalette,
        queuePosition: candy.queuePosition
      }
    });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/candy/queue — alle candies in de wachtrij ophalen
router.get('/queue', async (req, res) => {
  try {
    const candies = await Candy.find().sort({ queuePosition: 1 });
    res.json(candies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/candy/today — de actieve candy van vandaag
router.get('/today', async (req, res) => {
  try {
    const candy = await Candy.findOne({ status: 'active' });
    if (!candy) return res.status(404).json({ error: 'No active candy today' });
    res.json(candy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/candy/:id — candy verwijderen uit queue
router.delete('/:id', async (req, res) => {
  try {
    const candy = await Candy.findById(req.params.id);
    if (!candy) return res.status(404).json({ error: 'Candy not found' });

    await cloudinary.uploader.destroy(candy.cloudinaryId);
    await candy.deleteOne();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// PATCH /api/candy/:id/move — verplaats candy omhoog of omlaag in de queue
router.patch('/:id/move', async (req, res) => {
  try {
      const { direction } = req.body; // 'up' of 'down'
          const candy = await Candy.findById(req.params.id);
              if (!candy) return res.status(404).json({ error: 'Candy not found' });

                  const neighbor = direction === 'up'
                        ? await Candy.findOne({ queuePosition: { $lt: candy.queuePosition } }).sort({ queuePosition: -1 })
                              : await Candy.findOne({ queuePosition: { $gt: candy.queuePosition } }).sort({ queuePosition: 1 });

                                  if (!neighbor) {
                                        return res.status(400).json({ error: `Already at the ${direction === 'up' ? 'top' : 'bottom'}` });
                                            }

                                                // Swap queuePosition values
                                                    const tempPos = candy.queuePosition;
                                                        candy.queuePosition = neighbor.queuePosition;
                                                            neighbor.queuePosition = tempPos;

                                                                await candy.save();
                                                                    await neighbor.save();

                                                                        res.json({ success: true });
                                                                          } catch (err) {
                                                                              res.status(500).json({ error: err.message });
                                                                                }
        // GET /api/candy/next-date — suggereert de volgende datum op basis van laatste candy in queue
        // router.get('/next-date', async (req, res) => {
          try {
              const lastCandy = await Candy.findOne({ scheduledDate: { $ne: null } }).sort({ scheduledDate: -1 });
                  const baseDate = lastCandy ? new Date(lastCandy.scheduledDate) : new Date();
                      baseDate.setDate(baseDate.getDate() + 1);
                          res.json({ nextDate: baseDate.toISOString().split('T')[0] }); // YYYY-MM-DD formaat
                            } catch (err) {
                                res.status(500).json({ error: err.message });
                                  }
                                  });                                                                        });
module.exports = router;
