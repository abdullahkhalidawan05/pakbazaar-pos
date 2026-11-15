const express = require('express');
const { z } = require('zod');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('Admin'));

const staffColumns = 'id, name, role, is_active, created_at';

const editSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  is_active: z.boolean().optional()
})
  .strict()
  .refine(
    data => Object.keys(data).length > 0,
    { message: 'Provide a name or account status to update' }
  );

function handleError(res, error) {
  console.error('Staff operation failed:', error.message);

  return res.status(500).json({
    error: 'Unable to complete the staff operation'
  });
}

// List staff accounts.
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const { data, error } = await req.db
      .from('staff_profiles')
      .select(staffColumns)
      .order('name', { ascending: true });

    if (error) {
      return handleError(res, error);
    }

    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

// Update names, or change a cashier's active status.
router.patch('/:id', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);

  if (!parsedId.success) {
    return res.status(400).json({
      error: 'Invalid staff ID'
    });
  }

  const result = editSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid staff data',
      details: result.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    });
  }

  const changesStatus = Object.prototype.hasOwnProperty.call(
    result.data,
    'is_active'
  );

  if (changesStatus) return res.status(400).json({ error: 'Each shop has one admin login. Account status is managed by the system owner.' });

  try {
    let query = req.db
      .from('staff_profiles')
      .update(result.data)
      .eq('id', parsedId.data);

    // Admin status cannot be changed through this endpoint.
    if (changesStatus) {
      query = query.eq('role', 'Cashier');
    }

    const { data, error } = await query
      .select(staffColumns)
      .maybeSingle();

    if (error) {
      return handleError(res, error);
    }

    if (!data) {
      return res.status(404).json({
        error: changesStatus
          ? 'Cashier not found. Admin status cannot be changed here.'
          : 'Staff account not found'
      });
    }

    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

module.exports = router;