const express = require('express');
const { z } = require('zod');
const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

const money = z.number()
  .finite()
  .min(0)
  .max(9999999999.99)
  .multipleOf(0.01);

const productDate = z.string().refine(value => {
  if (!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, { message: 'Use a real calendar date in YYYY-MM-DD format' }).nullable().optional();

const productFields = z.object({
  manufacturing_date: productDate,
  expiry_date: productDate,
  name: z.string().trim().min(1).max(150),
  barcode: z.string().trim().min(1).max(100).nullable(),
  category: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(80),
  cost_price: money,
  retail_price: money,
  wholesale_price: money,
  wholesale_unit: z.string().trim().min(1).max(100),
  wholesale_pack_size: z.number().int().min(1).max(1000000),
  emoji: z.string().trim().min(1).max(20)
}).strict();

const createSchema = productFields.extend({
  stock: z.number().int().min(0).max(2147483647)
});

const editSchema = productFields
  .partial()
  .extend({
    is_active: z.boolean().optional()
  })
  .refine(
    data => Object.keys(data).length > 0,
    {
      message: 'Provide at least one field to update'
    }
  );

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid product data',
        details: result.error.issues.map(issue => ({
          field: issue.path.join('.') || 'body',
          message: issue.message
        }))
      });
    }

    if (result.data.manufacturing_date && result.data.expiry_date &&
        result.data.expiry_date < result.data.manufacturing_date) {
      return res.status(400).json({ error: 'Expiry date cannot be before manufacturing date' });
    }
    req.productData = result.data;
    return next();
  };
}

function validateId(req, res, next) {
  const rawId = req.params.id;
  const id = Number(rawId);

  if (
    !/^[1-9]\d*$/.test(rawId) ||
    !Number.isSafeInteger(id) ||
    id > 2147483647
  ) {
    return res.status(400).json({
      error: 'Invalid product ID'
    });
  }

  req.productId = id;
  return next();
}

function handleDatabaseError(res, error) {
  if (error?.code === '23514') return res.status(400).json({
    error: 'Check product prices and dates: prices must be non-negative, and expiry must be on or after manufacturing date'
  });
  if (error && error.code === '23505') {
    return res.status(409).json({
      error: 'A product with this barcode already exists'
    });
  }

  console.error(
    'Product operation failed:',
    error && error.message ? error.message : error
  );

  return res.status(500).json({
    error: 'Unable to complete the product operation'
  });
}

router.get('/', async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('id', { ascending: true });

    if (error) {
      return handleDatabaseError(res, error);
    }

    return res.json(data);
  } catch (error) {
    return handleDatabaseError(res, error);
  }
});

router.post(
  '/',
  requireRole('Admin'),
  validateBody(createSchema),
  async (req, res) => {
    try {
      const { data, error } = await req.db
        .from('products')
        .insert(req.productData)
        .select()
        .single();

      if (error) {
        return handleDatabaseError(res, error);
      }

      return res.status(201).json(data);
    } catch (error) {
      return handleDatabaseError(res, error);
    }
  }
);

router.patch(
  '/:id',
  requireRole('Admin'),
  validateId,
  validateBody(editSchema),
  async (req, res) => {
    try {
      const { data, error } = await req.db
        .from('products')
        .update(req.productData)
        .eq('id', req.productId)
        .select()
        .maybeSingle();

      if (error) {
        return handleDatabaseError(res, error);
      }

      if (!data) {
        return res.status(404).json({
          error: 'Product not found'
        });
      }

      return res.json(data);
    } catch (error) {
      return handleDatabaseError(res, error);
    }
  }
);

router.delete(
  '/:id',
  requireRole('Admin'),
  validateId,
  async (req, res) => {
    try {
      const { data, error } = await req.db
        .from('products')
        .update({ is_active: false })
        .eq('id', req.productId)
        .select('id, name, is_active')
        .maybeSingle();

      if (error) {
        return handleDatabaseError(res, error);
      }

      if (!data) {
        return res.status(404).json({
          error: 'Product not found'
        });
      }

      return res.json({
        message: 'Product deactivated',
        product: data
      });
    } catch (error) {
      return handleDatabaseError(res, error);
    }
  }
);

module.exports = router;