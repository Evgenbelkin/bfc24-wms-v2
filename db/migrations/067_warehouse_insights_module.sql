-- =============================================================================
-- BFC24 WMS v2 — Migration 067: модуль "Эффективность складов WB"
-- =============================================================================
-- Владелец, 19.09.2026: "хочу отчет который будет показывать по каждому
-- клиенту сколько заказов на каждый склад и % ... этот отчет должен быть
-- только если подключен тенанту ... не хочу засорять меню всякими фичами а
-- то кому-то может это не нужно".
--
-- В отличие от большинства прежних миграций с новым module_code (returns,
-- marking, consumables/payroll, ozon_integration), которые СРАЗУ включали
-- модуль всем существующим тенантам через INSERT INTO platform.tenant_modules
-- SELECT id, '<code>' FROM platform.tenants — здесь этого НАМЕРЕННО не делаем.
-- Модуль добавляется только в platform.modules (is_core=FALSE), а включать
-- его конкретным тенантам нужно вручную через существующую панель
-- platform/dashboard.html (renderModulesList/toggleModule ->
-- POST /platform/tenants/:id/modules) — ровно тот механизм точечного
-- вкл/выкл фич по тенанту, который уже есть в системе для wb_integration,
-- seller_cabinet, analytics и т.д. (см. server/src/middleware/tenant.js::
-- requireModule). Никакой новой инфраструктуры фича-флагов не требуется.
-- =============================================================================

BEGIN;

INSERT INTO platform.modules (module_code, module_name, description, is_core)
VALUES (
  'warehouse_insights',
  'Warehouse Insights',
  'Отчёт "Эффективность складов WB": заказы по каждому клиенту в разрезе складов WB (шт и %), чтобы видеть, какие склады эффективнее, и рекомендовать их другим клиентам',
  FALSE
)
ON CONFLICT (module_code) DO NOTHING;

COMMIT;
