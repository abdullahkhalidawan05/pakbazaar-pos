const express = require('express');
const { z } = require('zod');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

const customerFields = z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string()
    .trim()
    .regex(/^\+?[0-9]{7,15}$/, {
      message: 'Use 7 to 15 digits, optionally starting with +'
    })
    .nullable(),
  customer_type: z.enum(['Retail', 'Wholesale']),
  address: z.string().trim().max(500)
}).strict();

const createSchema = customerFields;

const editSchema = customerFields
  .partial()
  .extend({
    is_active: z.boolean().optional()
  })
  .refine(
    data => Object.keys(data).length > 0,
    { message: 'Provide at least one field to update' }
  );

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid customer data',
        details: result.error.issues.map(issue => ({
          field: issue.path.join('.') || 'body',
          message: issue.message
        }))
      });
    }

    req.customerData = result.data;
    return next();
  };
}

function databaseError(res, error) {
  console.error('Customer operation failed:', error.message);

  return res.status(500).json({
    error: 'Unable to complete the customer operation'
  });
}

// Active staff can view active customers.
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const { data, error } = await req.db
      .from('customers')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      return databaseError(res, error);
    }

    return res.json(data);
  } catch (error) {
    return databaseError(res, error);
  }
});

// Admins and cashiers can register customers.
router.post(
  '/',
  validateBody(createSchema),
  async (req, res) => {
    try {
      const { data, error } = await req.db
        .from('customers')
        .insert(req.customerData)
        .select()
        .single();

      if (error) {
        return databaseError(res, error);
      }

      return res.status(201).json(data);
    } catch (error) {
      return databaseError(res, error);
    }
  }
);

// Only admins can edit or deactivate customers.
router.patch(
  '/:id',
  requireRole('Admin'),
  validateBody(editSchema),
  async (req, res) => {
    const id = Number(req.params.id);

    if (
      !/^[1-9]\d*$/.test(req.params.id) ||
      !Number.isSafeInteger(id) ||
      id > 2147483647
    ) {
      return res.status(400).json({
        error: 'Invalid customer ID'
      });
    }

    try {
      const { data, error } = await req.db
        .from('customers')
        .update(req.customerData)
        .eq('id', id)
        .select()
        .maybeSingle();

      if (error) {
        return databaseError(res, error);
      }

      if (!data) {
        return res.status(404).json({
          error: 'Customer not found'
        });
      }

      return res.json(data);
    } catch (error) {
      return databaseError(res, error);
    }
  }
);

module.exports = router;