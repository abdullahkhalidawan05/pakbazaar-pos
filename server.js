require('dotenv').config();

const express = require('express');
const path = require('path');
const supabase = require('./supabase');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const settingsRoutes = require('./routes/settings');
const uploadRoutes = require('./routes/upload');
const salesRoutes = require('./routes/sales');
const staffRoutes = require('./routes/staff');
const customerRoutes = require('./routes/customers');
const returnRoutes = require('./routes/returns');
const stockRoutes = require('./routes/stock');
const creditRoutes = require('./routes/credits');
const reportRoutes = require('./routes/reports');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));

// Backend routes.
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/reports', reportRoutes);

// Database connection status.
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const { data, error } = await supabase
      .from('backend_connection_test')
      .select('message')
      .eq('id', 1)
      .single();

    if (error) {
      throw error;
    }

    return res.json({
      status: 'ok',
      message: 'POS API is running',
      database: 'connected',
      databaseMessage: data.message
    });
  } catch (error) {
    console.error('Database health check failed:', error.message);

    return res.status(503).json({
      status: 'error',
      message: 'POS API is running',
      database: 'connection check failed'
    });
  }
});

// Unknown API routes.
app.use('/api', (req, res) => {
  return res.status(404).json({
    error: 'API route not found'
  });
});

// Frontend homepage.
app.get('/', (req, res, next) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html'),
    error => {
      if (error) {
        next(error);
      }
    }
  );
});

// Frontend CSS, JavaScript, images, and other public files.
app.use(express.static(path.join(__dirname, 'public')));

// Error handling.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON request'
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request is too large'
    });
  }

  if (error.code === 'ENOENT' || error.status === 404) {
    return res.status(404).send(
      'Frontend file not found. Place index.html inside pos-backend/public.'
    );
  }

  console.error('Server error:', error.message);

  return res.status(500).json({
    error: 'Unexpected server error'
  });
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`POS running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;