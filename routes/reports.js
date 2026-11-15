const express = require('express');
const { z } = require('zod');
const supabase = require('../supabase');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('Admin'));

function pakistanToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const date = new Date(`${value}T00:00:00Z`);

    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, {
    message: 'Use a valid date in YYYY-MM-DD format'
  });

const querySchema = z.object({
  from: dateSchema,
  to: dateSchema
}).strict();

router.get('/summary', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const today = pakistanToday();

  const result = querySchema.safeParse({
    from: req.query.from ?? today,
    to: req.query.to ?? today
  });

  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid report dates',
      details: result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message
      }))
    });
  }

  const { from, to } = result.data;
  const dayCount = (
    Date.parse(`${to}T00:00:00Z`) -
    Date.parse(`${from}T00:00:00Z`)
  ) / 86400000;

  if (dayCount < 0 || dayCount > 365) {
    return res.status(400).json({
      error: 'Select a valid date range of up to 366 days'
    });
  }

  try {
    const { data, error } = await supabase.rpc('get_pos_report', {
      p_staff_id: req.user.id,
      p_from_date: from,
      p_to_date: to
    });

    if (error) {
      throw error;
    }

    return res.json(data);
  } catch (error) {
    console.error('Report failed:', {
      code: error.code,
      message: error.message,
      details: error.details
    });

    if (
      error.code === 'P0001' &&
      error.message === 'Admin access required'
    ) {
      return res.status(403).json({
        error: 'Admin access required'
      });
    }

    if (error.code === 'PGRST202') {
      return res.status(503).json({
        error: 'Report function unavailable. Complete the SQL setup.'
      });
    }

    return res.status(500).json({
      error: 'Unable to generate the report'
    });
  }
});

module.exports = router;