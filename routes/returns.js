const express = require('express');
const { z } = require('zod');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth, requireRole('Admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const uuid = z.string().uuid().transform(x => x.toLowerCase());
const money = z.number().finite().min(0).max(99999999999999.99);
const settlementSchema = z.object({
  currency: z.string().min(1).max(10), returned_total: money,
  replacement_total: money, credit_applied: money,
  cash_received: money, cash_refunded: money
}).strict();
const fields = z.object({
  request_id: uuid, original_sale_id: uuid,
  mode: z.enum(['CashRefund', 'Exchange']),
  reason: z.string().trim().min(1).max(500),
  return_items: z.array(z.object({
    sale_item_id: uuid, base_qty: z.number().int().min(1).max(2147483647),
    restock: z.boolean()
  }).strict()).min(1).max(100),
  exchange_items: z.array(z.object({
    product_id: z.number().int().min(1).max(2147483647),
    qty: z.number().int().min(1).max(1000000),
    tier: z.enum(['Retail', 'Wholesale'])
  }).strict()).max(100).default([])
}).strict();
function addRules(schema) {
  return schema.superRefine((data, ctx) => {
    if ((data.mode === 'CashRefund' && data.exchange_items.length) ||
        (data.mode === 'Exchange' && !data.exchange_items.length)) {
      ctx.addIssue({ code: 'custom', path: ['exchange_items'], message: 'Select replacements for exchanges only' });
    }
    const seen = new Set();
    for (const item of data.return_items) {
      if (seen.has(item.sale_item_id)) ctx.addIssue({ code: 'custom', path: ['return_items'], message: 'Duplicate returned item' });
      seen.add(item.sale_item_id);
    }
    seen.clear();
    for (const item of data.exchange_items) {
      const key = `${item.product_id}:${item.tier}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['exchange_items'], message: 'Combine duplicate replacement lines' });
      seen.add(key);
    }
  });
}
const previewSchema = addRules(fields);
const confirmSchema = addRules(fields.extend({ expected_settlement: settlementSchema }));
function fail(res, error) {
  console.error('Return operation failed:', { code: error.code, message: error.message, details: error.details });
  if (error.code === 'PGRST202') return res.status(503).json({ error: 'Return function unavailable. Run the supplied SQL and previous return setup.' });
  if (error.code === 'P0001') {
    if (error.message === 'SETTLEMENT_CHANGED') return res.status(409).json({ code: 'SETTLEMENT_CHANGED', error: 'Settlement changed. Review a fresh preview before confirming.' });
    const status = error.message === 'Admin access required' ? 403 :
      error.message === 'Original sale not found' ? 404 :
      error.message === 'Request ID already used with different return data' ? 409 : 400;
    return res.status(status).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Unable to complete the return operation' });
}
const saleColumns = 'id,receipt_no,cashier_name,customer_name,sale_type,payment_method,currency,subtotal,tax_rate,tax,total,created_at';
router.get('/receipt/:receiptNo', async (req, res) => {
  const receiptNo = req.params.receiptNo.trim();
  if (!receiptNo || receiptNo.length > 100) return res.status(400).json({ error: 'Invalid receipt number' });
  try {
    const { data: sale, error } = await supabase.from('sales').select(saleColumns).eq('receipt_no', receiptNo).maybeSingle();
    if (error) return fail(res, error);
    if (!sale) return res.status(404).json({ error: 'Receipt not found' });
    const { data: items, error: itemError } = await supabase.from('returnable_sale_items').select('*').eq('sale_id', sale.id).order('product_name');
    if (itemError) return fail(res, itemError);
    return res.json({ sale, items });
  } catch (error) { return fail(res, error); }
});
function processRequest(isPreview) {
  return async (req, res) => {
    const parsed = (isPreview ? previewSchema : confirmSchema).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      error: 'Invalid return data', details: parsed.error.issues.map(x => ({ field: x.path.join('.'), message: x.message }))
    });
    try {
      const input = parsed.data;
      const args = {
        p_request_id: input.request_id, p_staff_id: req.user.id,
        p_original_sale_id: input.original_sale_id, p_mode: input.mode,
        p_reason: input.reason, p_return_items: input.return_items,
        p_exchange_items: input.exchange_items
      };
      if (!isPreview) args.p_expected_settlement = input.expected_settlement;
      const { data, error } = await supabase.rpc(isPreview ? 'preview_return' : 'confirm_return', args);
      if (error) return fail(res, error);
      if (!data?.return) throw new Error('Return function produced no result');
      if (isPreview) {
        const r = data.return;
        return res.json({ settlement: {
          currency: r.currency, returned_total: Number(r.returned_total),
          replacement_total: Number(r.replacement_total), credit_applied: Number(r.credit_applied || 0),
          cash_received: Number(r.cash_received), cash_refunded: Number(r.cash_refunded)
        }, returned_items: data.returned_items, replacement_items: data.replacement_items });
      }
      return res.status(data.replayed ? 200 : 201).json(data);
    } catch (error) { return fail(res, error); }
  };
}
router.post('/preview', processRequest(true));
router.post('/', processRequest(false));
module.exports = router;
