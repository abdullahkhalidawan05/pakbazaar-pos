const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const paymentSchema = z.object({
  request_id: z.string().uuid(),
  currency: z.string().trim().min(1).max(10),
  amount: z.number()
    .finite()
    .positive()
    .max(99999999999999.99)
    .multipleOf(0.01),
  payment_method: z.enum(['Cash', 'Card']),
  note: z.string().trim().max(500).default('')
}).strict();

router.param('id', (req, res, next, rawId) => {
  const id = Number(rawId);

  if (
    !/^[1-9]\d*$/.test(rawId) ||
    !Number.isSafeInteger(id) ||
    id > 2147483647
  ) {
    return res.status(400).json({
      error: 'Invalid customer ID'
    });
  }

  req.customerId = id;
  return next();
});

function handleError(res, error) {
  console.error('Credit operation failed:', {
    code: error.code,
    message: error.message,
    details: error.details
  });

  if (error.code === '42501') return res.status(403).json({ error: 'Shop access denied' });

  if (error.code === 'P0001') {
    let status = 400;

    if (error.message === 'Customer not found') {
      status = 404;
    } else if (error.message === 'Staff access required') {
      status = 403;
    } else if (
      error.message ===
      'Request ID already used with different payment data'
    ) {
      status = 409;
    }

    return res.status(status).json({
      error: error.message
    });
  }

  if (error.code === 'PGRST202') {
    return res.status(503).json({
      error: 'Repayment function unavailable. Complete the SQL setup.'
    });
  }

  return res.status(500).json({
    error: 'Unable to complete the credit operation'
  });
}

// List customer credit accounts, 200 records per page.
router.get('/', async (req, res) => {
  const rawOffset = req.query.offset ?? '0';

  if (
    typeof rawOffset !== 'string' ||
    !/^\d{1,7}$/.test(rawOffset)
  ) {
    return res.status(400).json({
      error: 'Invalid offset'
    });
  }

  const offset = Number(rawOffset);

  try {
    const { data, error } = await req.db
      .from('customer_credit_accounts')
      .select('*')
      .order('customer_id', { ascending: true })
      .order('currency', { ascending: true })
      .range(offset, offset + 199);

    if (error) {
      return handleError(res, error);
    }

    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

// Latest 100 credit sales, repayments, and return adjustments.
router.get('/:id/transactions', async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('credit_transactions')
      .select(
        'id, customer_id, sale_id, return_id, entry_type, currency, ' +
        'amount_change, balance_after, payment_method, ' +
        'recorded_by, note, created_at'
      )
      .eq('customer_id', req.customerId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(100);

    if (error) {
      return handleError(res, error);
    }

    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

// Record a customer repayment.
router.post('/:id/pay', async (req, res) => {
  const result = paymentSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid payment data',
      details: result.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    });
  }

  try {
    const input = result.data;

    const { data, error } = await req.db.rpc(
      'record_credit_payment',
      {
        p_request_id: input.request_id,
        p_staff_id: req.user.id,
        p_customer_id: req.customerId,
        p_currency: input.currency,
        p_amount: input.amount,
        p_payment_method: input.payment_method,
        p_note: input.note
      }
    );

    if (error) {
      return handleError(res, error);
    }

    if (!data || !data.transaction) {
      throw new Error('Repayment returned no transaction');
    }

    return res.status(data.replayed ? 200 : 201).json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

module.exports = router;