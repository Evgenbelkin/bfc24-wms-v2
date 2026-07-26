'use strict';

/**
 * Определить принтер для нового print_job.
 *
 * Приоритет:
 *   1) Рабочее место сотрудника (wms.employee_active_station -> wms.workstations
 *      -> default_printer_id) — если сотрудник его сканировал и место активно,
 *      а у него задан активный принтер по умолчанию. Так на любой doc_type
 *      можно иметь сколько угодно принтеров одновременно (хоть 50 столов
 *      упаковки) — маршрут определяется физическим местом сотрудника, а не
 *      одним общим правилом на весь тенант.
 *   2) Fallback — прежняя логика wms.printer_routes (один маршрут по умолчанию
 *      на tenant+doc_type[+client_id]) — для складов/типов документов, ещё не
 *      переведённых на рабочие места. Ничего не ломает для тех, кому хватало
 *      одного принтера на тип документа.
 *
 * Возвращает { printerId, routeId } (routeId может быть null, если сработало
 * рабочее место) либо null, если печатать некуда — вызывающий код как и
 * раньше должен просто soft-fail (не создавать print_job).
 *
 * @param {Function} queryFn — pool.query либо client.query (внутри транзакции)
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.docType    — 'wb_sticker' | 'pick_list_label' | 'shipping_qr' | ...
 * @param {number} [opts.employeeId] — created_by; если не передан, шаг 1 пропускается
 * @param {number} [opts.clientId]   — доп. фильтр для printer_routes (сейчас использует только wb_sticker)
 */
async function resolvePrinter(queryFn, { tenantId, docType, employeeId, clientId }) {
  if (employeeId) {
    const stationRes = await queryFn(
      `SELECT ws.default_printer_id
       FROM wms.employee_active_station eas
       JOIN wms.workstations ws ON ws.id=eas.station_id
       JOIN wms.printers p ON p.id=ws.default_printer_id
       WHERE eas.employee_id=$1 AND eas.tenant_id=$2
         AND ws.is_active=TRUE AND p.is_active=TRUE AND ws.default_printer_id IS NOT NULL`,
      [employeeId, tenantId]
    );
    if (stationRes.rowCount > 0) {
      return { printerId: stationRes.rows[0].default_printer_id, routeId: null };
    }
  }

  let routeRes;
  if (clientId !== undefined) {
    routeRes = await queryFn(
      `SELECT pr.id, pr.printer_id FROM wms.printer_routes pr
       JOIN wms.printers p ON p.id=pr.printer_id
       WHERE pr.tenant_id=$1 AND pr.doc_type=$2 AND pr.is_active=TRUE AND p.is_active=TRUE
         AND (pr.client_id=$3 OR pr.client_id IS NULL)
       ORDER BY CASE WHEN pr.client_id=$3 THEN 0 ELSE 1 END, pr.id
       LIMIT 1`,
      [tenantId, docType, clientId]
    );
  } else {
    routeRes = await queryFn(
      `SELECT pr.id, pr.printer_id FROM wms.printer_routes pr
       JOIN wms.printers p ON p.id=pr.printer_id
       WHERE pr.tenant_id=$1 AND pr.doc_type=$2 AND pr.is_active=TRUE AND p.is_active=TRUE
       ORDER BY pr.is_default DESC, pr.id
       LIMIT 1`,
      [tenantId, docType]
    );
  }
  if (routeRes.rowCount === 0) return null;
  return { printerId: routeRes.rows[0].printer_id, routeId: routeRes.rows[0].id };
}

module.exports = { resolvePrinter };
