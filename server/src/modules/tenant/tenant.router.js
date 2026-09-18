'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./tenant.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');

router.use(authRequired, tenantMiddleware);

// =============================================================================
// Tenant Profile Router
// GET   /tenant/profile — реквизиты своей компании ("Исполнитель" в актах)
// PATCH /tenant/profile — редактировать (только tenant_admin)
// =============================================================================

// ВАЖНО: 'receiver' добавлен намеренно (баг, обнаруженный на проде) —
// receiving.html дёргает этот роут при открытии "Сформировать акт" (нужны
// реквизиты компании как "Исполнитель" в акте), это штатное действие
// приёмщика после оприходования. Без 'receiver' здесь приёмщик не может
// закрыть акт по своей же приёмке и, следовательно, не может выйти из
// экрана приёмки (гейт "есть непокрытый актом товар" блокирует выход,
// а форма акта, которая единственная снимает этот гейт, сама не открывалась
// из-за нехватки роли) — полный тупик для роли receiver.
router.get('/profile', requireRole('tenant_admin', 'supervisor', 'receiver'), async (req, res, next) => {
  try {
    const profile = await svc.getMyTenantProfile({ tenantId: req.user.tenantId });
    res.json({ ok: true, profile });
  } catch (e) { next(e); }
});

router.patch('/profile', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const profile = await svc.updateMyTenantProfile({ tenantId: req.user.tenantId, data: req.body });
    res.json({ ok: true, profile });
  } catch (e) { next(e); }
});

module.exports = router;
