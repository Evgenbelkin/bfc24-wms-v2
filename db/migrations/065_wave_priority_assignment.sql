-- =============================================================================
-- BFC24 WMS v2 — Migration 065: приоритет волны + назначение волны/упаковки
-- конкретному сборщику/упаковщику
-- =============================================================================
-- Запрос пользователя (17.09.2026): "сейчас волны падают по порядку, а нужно
-- сделать чтобы можно было задать приоритет волне и чтобы она в первую
-- очередь улетела на обработку на сборку или на упаковку" + вариант с явным
-- назначением конкретному сотруднику ("кликнул на волну выбрал упаковщика,
-- если он уже имеет волну — дождёмся когда закончит и после выпадет волна с
-- приоритетом").
--
-- priority — общий на всю отгрузку (одна и та же цифра действует и на
-- wms.pick_waves, и на wms.packing_tasks — эта же колонка там уже была,
-- просто раньше её никто не выставлял вручную). Меньше число — выше
-- приоритет (тот же порядок, что уже действовал внутри волны у
-- picking_tasks.priority и в очереди packing_tasks).
--
-- assigned_picker_id / assigned_packer_id — ПРЕДварительное назначение,
-- отдельное от picker_id/packer_id (который проставляется только когда
-- сотрудник реально взял волну/задачу в работу). Если волна размечена "для
-- Иванова" — другой сборщик её вообще не увидит в свободной очереди, а
-- Иванову она достанется первой, как только он освободится от текущей.
BEGIN;

ALTER TABLE wms.pick_waves
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS assigned_picker_id INT REFERENCES wms.users(id);

ALTER TABLE wms.packing_tasks
  ADD COLUMN IF NOT EXISTS assigned_packer_id INT REFERENCES wms.users(id);

CREATE INDEX IF NOT EXISTS idx_pick_waves_priority
  ON wms.pick_waves(tenant_id, status, priority);

CREATE INDEX IF NOT EXISTS idx_pick_waves_assigned
  ON wms.pick_waves(tenant_id, assigned_picker_id) WHERE assigned_picker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_packing_tasks_assigned
  ON wms.packing_tasks(tenant_id, assigned_packer_id) WHERE assigned_packer_id IS NOT NULL;

COMMENT ON COLUMN wms.pick_waves.priority IS
  'Приоритет отгрузки (меньше = раньше). Общий с wms.packing_tasks.priority на тот же shipment_code — задаётся одним действием в диспетчерской.';
COMMENT ON COLUMN wms.pick_waves.assigned_picker_id IS
  'Волна закреплена за конкретным сборщиком (админ назначил заранее) — достанется ЕМУ первой, как только освободится; другим свободным сборщикам в очереди не показывается.';
COMMENT ON COLUMN wms.packing_tasks.assigned_packer_id IS
  'Задача на упаковку закреплена за конкретным упаковщиком (админ назначил заранее) — аналогично assigned_picker_id у волны.';

COMMIT;
