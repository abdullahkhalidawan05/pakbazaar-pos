const express = require('express');
const { z } = require('zod');
const supabase = require('../supabase');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('Admin'));

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const stockSchema = z.object({
  request_id: z.string().uuid(),
  product_id: z.number().int().min(1).max(2147483647),
  movement_type: z.enum(['Restock', 'Adjustment']),
  quantity_change: z.number()
    .int()
    .min(-2147483647)
    .max(2147483647)
    .refine(value => value !== 0, {
      message: 'Quantity change must not be zero'
    }),
  reason: z.string().trim().min(1).max(500)
})
  .strict()
  .refine(
    data =>
      data.movement_type !== 'Restock' ||
      data.quantity_change > 0,
    {
      path: ['quantity_change'],
      message: 'Restock quantity must be positive'
    }
  );

function handleError(res, error) {
  console.error('Stock operation failed:', {
    code: error.code,
    message: error.message,
    details: error.details
  });

  if (error.code === 'P0001') {
    let status = 400;

    if (error.message === 'Admin access required') {
      status = 403;
    } else if (error.message === 'Product not found') {
      status = 404;
    } else if (
      error.message ===
      'Request ID already used with different stock data'
    ) {
      status = 409;
    }

    return res.status(status).json({
      error: error.message
    });
  }

  if (error.code === 'PGRST202') {
    return res.status(503).json({
      error: 'Stock function unavailable. Complete the SQL setup.'
    });
  }

  return res.status(500).json({
    error: 'Unable to complete the stock operation'
  });
};

// Add stock or record a correction.
router.post('/adjust', async (req, res) => {
  const result = stockSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid stock data',
      details: result.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    });
  }

  try {
    const input = result.data;

    const { data, error } = await supabase.rpc('adjust_stock', {
      p_request_id: input.request_id,
      p_staff_id: req.user.id,
      p_product_id: input.product_id,
      p_movement_type: input.movement_type,
      p_quantity_change: input.quantity_change,
      p_reason: input.reason
    });

    if (error) {
      return handleError(res, error);
    }

    if (!data || !data.movement) {
      throw new Error('Stock operation returned no movement');
    }

    return res.status(data.replayed ? 200 : 201).json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

// Latest 100 stock movements, optionally filtered by product.
router.get('/movements', async (req, res) => {
  try {
    let query = supabase
      .from('stock_movements')
      .select(
        'id, product_id, sale_id, return_id, movement_type, ' +
        'quantity_change, stock_after, performed_by, reason, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (req.query.product_id !== undefined) {
      const rawId = req.query.product_id;
      const id = Number(rawId);

      if (
        typeof rawId !== 'string' ||
        !/^[1-9]\d*$/.test(rawId) ||
        !Number.isSafeInteger(id) ||
        id > 2147483647
      ) {
        return res.status(400).json({
          error: 'Invalid product ID'
        });
      }

      query = query.eq('product_id', id);
    }

    const { data, error } = await query;

    if (error) {
      return handleError(res, error);
    }

    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

module.exports = router;