const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const saleItemSchema = z.object({
  product_id: z.number().int().min(1).max(2147483647),
  qty: z.number().int().min(1).max(1000000),
  tier: z.enum(['Retail', 'Wholesale']),
  price_override: z.number().finite().min(0).max(9999999999.99).multipleOf(0.01).optional()
}).strict();

const saleSchema = z.object({
  request_id: z.string().uuid(),
  discount_type: z.enum(['Amount','Percent']).default('Amount'),
  discount_value: z.number().finite().min(0).max(99999999999999.99).multipleOf(0.01).default(0),
  customer_id: z.number()
    .int()
    .min(1)
    .max(2147483647)
    .nullable()
    .optional(),
  sale_type: z.enum(['Retail', 'Wholesale']),
  payment_method: z.enum(['Cash', 'Card', 'Credit']),
  tendered_amount: z.number()
    .finite()
    .min(0)
    .max(99999999999999.99)
    .multipleOf(0.01)
    .nullable()
    .optional(),
  items: z.array(saleItemSchema).min(1).max(100)
})
  .strict()
  .superRefine((sale, context) => {
    if (
      sale.payment_method === 'Cash' &&
      sale.tendered_amount == null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tendered_amount'],
        message: 'Cash tendered amount is required'
      });
    }

    if (
      sale.payment_method !== 'Cash' &&
      sale.tendered_amount != null &&
      sale.tendered_amount !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tendered_amount'],
        message: 'Only Cash payments accept a tendered amount'
      });
    }

    if (
      sale.payment_method === 'Credit' &&
      sale.customer_id == null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['customer_id'],
        message: 'Select a customer for a credit sale'
      });
    }

    if(sale.discount_type==='Percent' && sale.discount_value>100)context.addIssue({code:'custom',path:['discount_value'],message:'Percentage cannot exceed 100%'});
    const seen = new Set();

    sale.items.forEach((item, index) => {
      const key = `${item.product_id}:${item.tier}`;

      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'Combine duplicate product lines of the same tier'
        });
      }

      seen.add(key);
    });
  });

const saleColumns = [
  'id', 'request_id', 'receipt_no',
  'cashier_id', 'cashier_name',
  'customer_id', 'customer_name', 'customer_phone',
  'sale_type', 'payment_method', 'currency',
  'gross_subtotal', 'discount_amount', 'discount_type', 'discount_value',
  'subtotal', 'tax_rate', 'tax', 'total',
  'tendered_amount', 'change_amount', 'created_at'
].join(',');

function handleError(res, error) {
  console.error('Sales operation failed:', {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint
  });

  if (error.code === 'PGRST202') {
    return res.status(503).json({
      error: 'Checkout function unavailable. Complete the SQL setup.'
    });
  }

  if (error.code === '42501') return res.status(403).json({ error: 'Shop access denied' });

  if (error.code === 'P0001') {
    let status = 400;

    if (error.message === 'Staff access required') {
      status = 403;
    } else if (
      error.message ===
      'Request ID already used with different sale data'
    ) {
      status = 409;
    } else if (
      error.message === 'Customer not found' ||
      error.message === 'Product not found'
    ) {
      status = 404;
    } else if (error.message === 'Store settings not found') {
      status = 503;
    }

    return res.status(status).json({
      error: error.message
    });
  }

  return res.status(500).json({
    error: 'Unable to complete the sale operation'
  });
}

router.post('/', async (req, res) => {
  const result = saleSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid sale data',
      details: result.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    });
  }

  try {
    const sale = result.data;

    const { data, error } = await req.db.rpc('checkout_sale_discount', {
      p_request_id: sale.request_id,
      p_cashier_id: req.user.id,
      p_sale_type: sale.sale_type,
      p_payment_method: sale.payment_method,
      p_items: sale.items,
      p_discount_type: sale.discount_type,
      p_discount_value: sale.discount_value,
      p_tendered_amount: sale.tendered_amount ?? null,
      p_customer_id: sale.customer_id ?? null
    });

    if (error) {
      return handleError(res, error);
    }

    if (!data || !data.sale) {
      throw new Error('Checkout returned no sale');
    }

    return res.status(data.replayed ? 200 : 201).json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/', async (req, res) => {
  try {
    let query = req.db
      .from('sales')
      .select(saleColumns)
      .order('created_at', { ascending: false })
      .limit(100);

    if (req.user.role !== 'Admin') {
      query = query.eq('cashier_id', req.user.id);
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

router.get('/:id', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);

  if (!parsedId.success) {
    return res.status(400).json({
      error: 'Invalid sale ID'
    });
  }

  try {
    let query = req.db
      .from('sales')
      .select(`${saleColumns},sale_items!sale_items_sale_id_shop_fk(*)`)
      .eq('id', parsedId.data);

    if (req.user.role !== 'Admin') {
      query = query.eq('cashier_id', req.user.id);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      return handleError(res, error);
    }

    if (!data) {
      return res.status(404).json({
        error: 'Sale not found'
      });
    }

    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

module.exports = router;