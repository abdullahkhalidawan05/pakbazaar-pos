const express = require('express');
const { z } = require('zod');
const supabase = require('../supabase');
const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

const settingsSchema = z.object({
  store_name: z.string().trim().min(1).max(150),
  tagline: z.string().trim().max(200),
  branch: z.string().trim().max(150),
  address: z.string().trim().max(500),
  phone: z.string().trim().max(50),
  tax_id: z.string().trim().max(80),
  currency: z.string().trim().min(1).max(10),
  tax_rate: z.number()
    .finite()
    .min(0)
    .max(100)
    .multipleOf(0.01),
  receipt_width: z.enum(['58mm', '80mm']),
  icon: z.string().trim().min(1).max(20),
  footer: z.string().trim().max(1000)
})
  .strict()
  .partial()
  .refine(
    data => Object.keys(data).length > 0,
    { message: 'Provide at least one setting to update' }
  );

function databaseError(res, error) {
  console.error('Settings operation failed:', error.message);

  return res.status(500).json({
    error: 'Unable to complete the settings operation'
  });
}

// Active staff can read settings.
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('store_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      return databaseError(res, error);
    }

    if (!data) {
      return res.status(404).json({
        error: 'Store settings have not been created'
      });
    }

    return res.json(data);
  } catch (error) {
    return databaseError(res, error);
  }
});

// Only admins can change settings.
router.patch('/', requireRole('Admin'), async (req, res) => {
  const result = settingsSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid settings data',
      details: result.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    });
  }

  try {
    const { data, error } = await supabase
      .from('store_settings')
      .update({
        ...result.data,
        updated_at: new Date().toISOString()
      })
      .eq('id', 1)
      .select()
      .maybeSingle();

    if (error) {
      return databaseError(res, error);
    }

    if (!data) {
      return res.status(404).json({
        error: 'Store settings have not been created'
      });
    }

    return res.json(data);
  } catch (error) {
    return databaseError(res, error);
  }
});

module.exports = router;