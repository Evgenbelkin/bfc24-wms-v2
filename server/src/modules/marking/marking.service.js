'use strict';

const bcrypt = require('bcryptjs');
const { query, transaction } = require('../../config/database');
const { resolvePrinter } = require('../printing/printerResolver');
const { generateMarkingLabelSvg } = require('../../utils/qrcode');
const { ValidationError, ForbiddenError } = require('../../utils/errors');
const { isValidKizCode, hasValidKizStructure } = require('../../utils/validators');
const wbClient = require('../wb/wb.client');
const logger = require('../../utils/logger');

// =============================================================================
// Marking Service — локальный учёт кодов "Честный знак"
// Только локальный учёт (без ЦРПТ), без агрегации (код = 1 физическая единица).
// Коды заранее импортируются оператором в пул на конкретный товар, затем
// раздаются по одному при приёмке/упаковке (см. allocateAndPrint).
// =============================================================================

/** Разобрать текстовый блок кодов (по одному на строку) в массив без пустых/дублей */
function parseCodesText(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

/** Импортировать коды в пул на товар */
async function importCodes({ tenantId, itemId, createdBy, codesText }) {
  const allCodes = parseCodesText(codesText);
  if (allCodes.length === 0) throw new ValidationError('Нет ни одного кода для импорта');

  // Отсекаем то, что явно не похоже на КИЗ (например, в это же поле вставили
  // список обычных штрихкодов товара по ошибке) — не роняем весь импорт
  // целиком, а просто пропускаем такие строки и честно говорим сколько.
  const longEnough = allCodes.filter(isValidKizCode);
  const skippedInvalid = allCodes.length - longEnough.length;

  // Отдельно отсекаем структурно повреждённые коды (похожи по длине на КИЗ,
  // но разделитель GS1 потерян или задвоен — реальный инцидент показал, что
  // это типично для скана камерой телефона, см. hasValidKizStructure). Такие
  // коды технически "похожи" на КИЗ, но неизбежно провалятся при отправке в
  // WB — лучше поймать это здесь, чем через несколько дней в кабинете WB.
  const codes = longEnough.filter(hasValidKizStructure);
  const skippedBroken = longEnough.length - codes.length;
  if (codes.length === 0) {
    if (skippedBroken > 0) {
      throw new ValidationError(
        `${skippedBroken} код(ов) похожи на "Честный знак" по длине, но структура повреждена (потерян или задвоен служебный разделитель) — обычно так бывает при скане камерой телефона. Пересканируйте физическим сканером в режиме GS1 DataMatrix.`
      );
    }
    throw new ValidationError(
      `Ни одна из ${allCodes.length} строк не похожа на код "Честный знак" (слишком короткие — похоже на обычные штрихкоды товара)`
    );
  }

  const itemRes = await query(`SELECT id FROM wms.items WHERE id=$1 AND tenant_id=$2`, [itemId, tenantId]);
  if (itemRes.rowCount === 0) throw new ValidationError('Item not found');

  let imported = 0;
  for (const code of codes) {
    const r = await query(
      `INSERT INTO wms.marking_codes (tenant_id, item_id, code, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, code) DO NOTHING
       RETURNING id`,
      [tenantId, itemId, code, createdBy]
    );
    if (r.rowCount > 0) imported++;
  }
  return { imported, duplicates: codes.length - imported, skipped_invalid: skippedInvalid, skipped_broken_structure: skippedBroken, total_in_batch: allCodes.length };
}

/**
 * Импортировать коды из загруженного Excel-файла (.xlsx) — альтернатива ручной
 * вставке текстом/сканированию, когда у клиента уже есть выгрузка кодов из
 * "Честного знака" файлом. Берём первый лист, читаем ВСЕ непустые ячейки (не
 * только первую колонку) — не важно, в каком столбце/с какой шапкой клиент
 * выгрузил список, лишний текст (заголовки и т.п.) всё равно отсеется той же
 * проверкой длины, что и при обычном текстовом импорте (см. importCodes).
 */
async function importCodesFromExcel({ tenantId, itemId, createdBy, fileBuffer }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(fileBuffer);
  } catch (e) {
    throw new ValidationError('Не удалось прочитать файл — убедитесь, что это корректный .xlsx');
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw new ValidationError('В файле нет ни одного листа');

  const values = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const v = cell.value;
      if (v == null) return;
      let text;
      if (typeof v === 'object') {
        if (Array.isArray(v.richText)) text = v.richText.map((r) => r.text).join('');
        else text = v.text != null ? String(v.text) : (v.result != null ? String(v.result) : '');
      } else {
        text = String(v);
      }
      text = text.trim();
      if (text) values.push(text);
    });
  });

  if (!values.length) throw new ValidationError('В файле не нашлось ни одного заполненного значения');

  return importCodes({ tenantId, itemId, createdBy, codesText: values.join('\n') });
}

/** Удалить код из пула (только пока он 'available' — использованный код это уже
 *  исторический факт, в т.ч. возможно уже отправленный в WB, удалять нельзя,
 *  чтобы не потерять аудит). Для случаев, когда в пул случайно занесли
 *  "левый" код (опечатка при ручном вводе, не настоящий скан DataMatrix) —
 *  раньше почистить пул было нечем, код так и висел там навсегда. */
async function deleteCode({ tenantId, itemId, codeId }) {
  const r = await query(
    `DELETE FROM wms.marking_codes WHERE id=$1 AND tenant_id=$2 AND item_id=$3 AND status='available' RETURNING id, code`,
    [codeId, tenantId, itemId]
  );
  if (r.rowCount === 0) {
    const exists = await query(`SELECT status FROM wms.marking_codes WHERE id=$1 AND tenant_id=$2 AND item_id=$3`, [codeId, tenantId, itemId]);
    if (exists.rowCount === 0) throw new ValidationError('Код не найден в пуле этого товара');
    throw new ValidationError(`Код уже использован (статус '${exists.rows[0].status}') — удалить нельзя, только свободные коды`);
  }
  return r.rows[0];
}

/** Сводка по товару: сколько кодов свободно / использовано */
async function getCodesSummary({ tenantId, itemId }) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status='available')::int AS available,
       COUNT(*) FILTER (WHERE status='used')::int       AS used,
       COUNT(*) FILTER (WHERE wb_submit_status='manual_override')::int AS manual_override,
       COUNT(*)::int AS total
     FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2`,
    [tenantId, itemId]
  );
  return r.rows[0];
}

/** Список кодов пула (для просмотра — какие коды ещё свободны, какие уже ушли) */
async function listCodes({ tenantId, itemId, status = null, limit = 200, offset = 0 }) {
  const params = [tenantId, itemId];
  let cond = 'tenant_id=$1 AND item_id=$2';
  if (status) { cond += ` AND status=$3`; params.push(status); }
  params.push(Math.min(limit, 1000), Math.max(offset, 0));
  const r = await query(
    `SELECT id, code, status, source, used_at, used_ref_type, used_ref_id,
            wb_order_id, wb_submit_status, wb_submitted_at, wb_override_reason, created_at
     FROM wms.marking_codes WHERE ${cond}
     ORDER BY id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows;
}

/**
 * Нужно ли маркировать этот товар на данном этапе ('receiving' | 'packing').
 *
 * Для marking_mode='print' — выбор пользователя marking_trigger (печатаем
 * ЛИБО на приёмке, ЛИБО на упаковке — одно из двух).
 *
 * Для marking_mode='scan' — marking_trigger не применяется вообще: скан
 * DataMatrix обязателен на ОБОИХ этапах всегда — на приёмке код заносится
 * в локальный пул (иначе взять код на сборке будет неоткуда), а на упаковке
 * код сверяется с конкретной физической единицей и уходит в WB API (только
 * там известен orderId). Одно без другого не работает.
 *
 * Для marking_mode='scan_packing' (третий сценарий, см. миграцию 046) —
 * приёмка вообще не участвует: код клиента сканируется ВПЕРВЫЕ прямо на
 * упаковке, регистрируется в пуле и сразу же гасится тем же действием (см.
 * consumeScannedCodeAtPacking с autoRegister=true в packing.service.js).
 */
function shouldMarkAt(item, stage) {
  if (!item || !item.requires_marking) return false;
  if (item.marking_mode === 'scan') return true;
  if (item.marking_mode === 'scan_packing') return stage === 'packing';
  return (item.marking_trigger || 'packing') === stage;
}

// =============================================================================
// Режим 'scan' — клиент маркирует товар сам (DataMatrix уже на товаре до
// поступления на ФФ). ФФ не печатает и не выделяет коды из пула — сканирует
// уже существующий код: на приёмке регистрирует его в пул, на сборке FBS-
// заказа сверяет с пулом и ОТПРАВЛЯЕТ В WB через meta/sgtin.
// Таблица wms.marking_codes и её пул (available/used) переиспользуются как
// есть — отличается только способ пополнения (скан вместо CSV-импорта) и
// способ расходования (сверка+отправка в WB вместо печати стикера).
// =============================================================================

/**
 * Зарегистрировать в пуле коды, отсканированные на приёмке (режим 'scan').
 * Каждый код — уникальная физическая единица, уже промаркированная клиентом.
 * ЖЁСТКАЯ БЛОКИРОВКА: код не передан, пуст, или уже существует в системе
 * (повторный скан ИЛИ реальное нарушение — один код не может быть на двух
 * разных единицах) — throw откатывает всю операцию приёмки.
 */
async function registerScannedCodes({ tenantId, itemId, codes, userId, dbClient = null }) {
  const list = (Array.isArray(codes) ? codes : [codes])
    .map(c => String(c || '').trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new ValidationError(
      `Товар промаркирован клиентом (Честный знак) — отсканируйте код DataMatrix ` +
      `с каждой принимаемой единицы, прежде чем продолжить приёмку.`
    );
  }

  // Проверка ДО начала транзакции — если в поле для КИЗ прилетел обычный
  // товарный штрихкод (частый случай: сканер/фокус промахнулись мимо поля,
  // или оператор по привычке отсканировал этикетку товара вместо кода
  // маркировки), явно и понятно объясняем что не так, вместо невнятной
  // ошибки от INSERT или (хуже) тихой регистрации штрихкода как "кода
  // маркировки". См. isValidKizCode в utils/validators.js — реальный КИЗ
  // всегда заметно длиннее любого товарного штрихкода.
  const badCode = list.find(c => !isValidKizCode(c));
  if (badCode) {
    throw new ValidationError(
      `"${badCode}" не похож на код "Честный знак" (слишком короткий — похоже, отсканирован обычный штрихкод товара). ` +
      `Отсканируйте код DataMatrix с этикетки маркировки, а не штрихкод товара.`
    );
  }

  // Отдельная проверка структуры (не только длины) — см. hasValidKizStructure.
  // Реальный инцидент показал: скан камерой телефона может выдать код нужной
  // длины, но с потерянным/задвоенным служебным разделителем — такой код
  // технически пройдёт как "похож на КИЗ", но неизбежно провалится при
  // отправке в WB ("неверная структура маркировки"), причём узнаём мы об этом
  // не сразу, а через дни, когда код уже "использован". Ловим здесь.
  const brokenCode = list.find(c => !hasValidKizStructure(c));
  if (brokenCode) {
    // Временная диагностика: логируем байты отклонённого кода в hex, чтобы
    // можно было разобрать структуру по логам pm2, не трогая проверку и не
    // давая битому коду попасть в БД. Смотри также предыдущий инцидент с GS1.
    logger.warn(
      { tenantId, itemId, len: brokenCode.length, hex: Buffer.from(brokenCode, 'binary').toString('hex') },
      'registerScannedCodes: код отклонён проверкой структуры (hasValidKizStructure)'
    );
    throw new ValidationError(
      `Код похож на "Честный знак" по длине, но структура повреждена (потерян или задвоен служебный разделитель) — обычно так бывает при скане камерой телефона. ` +
      `Пересканируйте физическим сканером в режиме GS1 DataMatrix.`
    );
  }

  const doRegister = async (client) => {
    const insertedIds = [];
    for (const code of list) {
      const r = await client.query(
        `INSERT INTO wms.marking_codes (tenant_id, item_id, code, status, source, created_by)
         VALUES ($1,$2,$3,'available','scanned',$4)
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING id`,
        [tenantId, itemId, code, userId]
      );
      if (r.rowCount === 0) {
        throw new ValidationError(
          `Код "Честный знак" уже зарегистрирован в системе: ${code}. Один код маркировки ` +
          `может принадлежать только одной физической единице — проверьте, не отсканирован ли он повторно, ` +
          `или сообщите клиенту о возможном дублировании кода на производстве.`
        );
      }
      insertedIds.push(r.rows[0].id);
    }

    const remainingRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND status='available'`,
      [tenantId, itemId]
    );
    return { registered: insertedIds.length, remaining: remainingRes.rows[0].n };
  };

  return dbClient ? doRegister(dbClient) : transaction(doRegister);
}

/**
 * Сверить отсканированный на сборке DataMatrix с пулом и ОТПРАВИТЬ В WB
 * (PUT .../orders/{orderId}/meta/sgtin) — замена ручного ввода кода в
 * кабинете WB. ЖЁСТКАЯ БЛОКИРОВКА: throw откатывает всю транзакцию упаковки,
 * если код не найден в пуле/уже использован, либо WB API не принял код —
 * см. marking.overrideMarkingAtPacking() для аварийного обхода супервайзером.
 */
async function consumeScannedCodeAtPacking({
  tenantId, itemId, code, wbOrderId, apiToken, refType, refId, userId, dbClient = null,
  skipWbSubmit = false, autoRegister = false,
}) {
  const doConsume = async (client) => {
    const codeStr = String(code || '').trim();
    if (!codeStr) {
      throw new ValidationError(
        `Товар промаркирован клиентом (Честный знак) — отсканируйте код DataMatrix ` +
        `именно той единицы, которую кладёте в этот заказ.`
      );
    }

    let codeRes = await client.query(
      `SELECT id, status FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND code=$3 FOR UPDATE`,
      [tenantId, itemId, codeStr]
    );
    if (codeRes.rowCount === 0 && !autoRegister) {
      throw new ValidationError(
        `Код "Честный знак" (${codeStr}) не найден в пуле этого товара. Убедитесь, что единица была ` +
        `принята на склад (код регистрируется сканом при приёмке) и что отсканирован код именно с неё.`
      );
    }
    if (codeRes.rowCount === 0 && autoRegister) {
      // Третий сценарий (marking_mode='scan_packing', см. миграцию 046) —
      // приёмки не было, это первый раз, когда мы вообще видим этот код.
      // Та же валидация, что и при обычной регистрации на приёмке (см.
      // registerScannedCodes выше) - это единственный момент, когда можно
      // поймать битую структуру (потерянный GS1-разделитель и т.п.), другого
      // шанса не будет.
      if (!isValidKizCode(codeStr)) {
        throw new ValidationError(
          `"${codeStr}" не похож на код "Честный знак" (слишком короткий — похоже, отсканирован обычный штрихкод товара). ` +
          `Отсканируйте код DataMatrix с этикетки маркировки, а не штрихкод товара.`
        );
      }
      if (!hasValidKizStructure(codeStr)) {
        logger.warn(
          { tenantId, itemId, len: codeStr.length, hex: Buffer.from(codeStr, 'binary').toString('hex') },
          'consumeScannedCodeAtPacking: код отклонён проверкой структуры (авторегистрация на упаковке, scan_packing)'
        );
        throw new ValidationError(
          `Код похож на "Честный знак" по длине, но структура повреждена (потерян или задвоен служебный разделитель) — обычно так бывает при скане камерой телефона. ` +
          `Пересканируйте физическим сканером в режиме GS1 DataMatrix.`
        );
      }
      const insRes = await client.query(
        `INSERT INTO wms.marking_codes (tenant_id, item_id, code, status, source, created_by)
         VALUES ($1,$2,$3,'available','scanned',$4)
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING id, status`,
        [tenantId, itemId, codeStr, userId]
      );
      if (insRes.rowCount === 0) {
        throw new ValidationError(
          `Код "Честный знак" (${codeStr}) уже зарегистрирован в системе — один код может принадлежать ` +
          `только одной физической единице.`
        );
      }
      codeRes = insRes;
    }
    const row = codeRes.rows[0];
    if (row.status !== 'available') {
      throw new ValidationError(`Код "Честный знак" (${codeStr}) уже использован — повторно применить нельзя.`);
    }

    // skipWbSubmit — рубильник клиента (settings.marking_wb_submit_disabled,
    // см. clients.service.js). Физическая привязка "этот код ушёл в этот
    // заказ" сохраняется ВСЕГДА (см. UPDATE ниже) - это нужно для трассировки
    // и для выгрузки по поставке. В WB API код в этом случае не шлём вообще:
    // право собственности на код в Честном знаке ещё не передано на нужное
    // ИП (см. миграцию 044), а WB проверяет код при отправке от секунд до
    // нескольких минут - отправка здесь могла бы не пройти проверку.
    if (skipWbSubmit) {
      await client.query(
        `UPDATE wms.marking_codes
         SET status='used', used_at=NOW(), used_ref_type=$1, used_ref_id=$2, used_by=$3,
             wb_order_id=$4, wb_submit_status='export_only'
         WHERE id=$5`,
        [refType, refId, userId, wbOrderId || null, row.id]
      );
      const remainingRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND status='available'`,
        [tenantId, itemId]
      );
      return { code: codeStr, wb_submitted: false, export_only: true, remaining: remainingRes.rows[0].n };
    }

    if (!wbOrderId) {
      throw new ValidationError(
        `Не найден номер заказа WB для этой единицы — невозможно привязать код маркировки к заказу.`
      );
    }
    if (!apiToken) {
      throw new ValidationError(
        `Не найден токен WB API для отправки кода маркировки — проверьте подключение кабинета WB у клиента.`
      );
    }

    // Отправляем в WB ДО пометки кода использованным: если WB API вернёт
    // ошибку, throw откатит и это UPDATE, и всю остальную упаковку —
    // код останется available для повторной попытки.
    await wbClient.setOrderKiz(apiToken, wbOrderId, [codeStr]);

    await client.query(
      `UPDATE wms.marking_codes
       SET status='used', used_at=NOW(), used_ref_type=$1, used_ref_id=$2, used_by=$3,
           wb_order_id=$4, wb_submit_status='sent', wb_submitted_at=NOW()
       WHERE id=$5`,
      [refType, refId, userId, wbOrderId, row.id]
    );

    const remainingRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND status='available'`,
      [tenantId, itemId]
    );
    return { code: codeStr, wb_submitted: true, remaining: remainingRes.rows[0].n };
  };

  return dbClient ? doConsume(dbClient) : transaction(doConsume);
}

/**
 * Аварийный обход (решение пользователя): если WB API недоступен и упаковку
 * нельзя продолжать без завершения строки — супервайзер/админ может провести
 * единицу БЕЗ отправки в WB, указав причину. Код помечается использованным
 * с wb_submit_status='manual_override' и попадает в список "требует ручной
 * привязки КИЗ" (см. listPendingManualOverrides) — ничего не теряется молча.
 *
 * Права проверяются здесь же по логину/паролю супервайзера (а не по роли
 * текущей сессии упаковщика) — на полу склада обычно один терминал на
 * упаковщика, и супервайзер подтверждает действие своими кредами прямо на
 * этом же экране, не переlogинивая упаковщика.
 */
async function overrideMarkingAtPacking({
  tenantId, itemId, code, refType, refId, packerId,
  supervisorUsername, supervisorPassword, reason, dbClient = null, autoRegister = false,
}) {
  const codeStr = String(code || '').trim();
  if (!codeStr) throw new ValidationError('Не указан код "Честный знак" для проведения без отправки в WB');
  if (!reason || !String(reason).trim()) {
    throw new ValidationError('Укажите причину проведения без отправки кода в WB');
  }

  const userRes = await query(
    `SELECT id, password_hash, role, is_active FROM wms.users WHERE tenant_id=$1 AND username=$2`,
    [tenantId, supervisorUsername]
  );
  if (userRes.rowCount === 0 || !userRes.rows[0].is_active) {
    throw new ForbiddenError('Неверный логин или пароль супервайзера');
  }
  const supervisor = userRes.rows[0];
  if (!['supervisor', 'tenant_admin'].includes(supervisor.role)) {
    throw new ForbiddenError('Проводить упаковку без отправки КИЗ в WB может только супервайзер или администратор');
  }
  const passOk = await bcrypt.compare(String(supervisorPassword || ''), supervisor.password_hash);
  if (!passOk) throw new ForbiddenError('Неверный логин или пароль супервайзера');

  const doOverride = async (client) => {
    let codeRes = await client.query(
      `SELECT id, status FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND code=$3 FOR UPDATE`,
      [tenantId, itemId, codeStr]
    );
    if (codeRes.rowCount === 0 && !autoRegister) {
      throw new ValidationError(`Код "Честный знак" (${codeStr}) не найден в пуле этого товара.`);
    }
    if (codeRes.rowCount === 0 && autoRegister) {
      // scan_packing (миграция 046) - см. тот же случай в
      // consumeScannedCodeAtPacking выше: приёмки не было, регистрируем код
      // впервые прямо здесь, тем же аварийным проведением супервайзером.
      if (!isValidKizCode(codeStr) || !hasValidKizStructure(codeStr)) {
        throw new ValidationError(
          `Код "Честный знак" (${codeStr}) не похож на корректный DataMatrix (проверьте длину/структуру) — не могу зарегистрировать.`
        );
      }
      const insRes = await client.query(
        `INSERT INTO wms.marking_codes (tenant_id, item_id, code, status, source, created_by)
         VALUES ($1,$2,$3,'available','scanned',$4)
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING id, status`,
        [tenantId, itemId, codeStr, packerId]
      );
      if (insRes.rowCount === 0) {
        throw new ValidationError(`Код "Честный знак" (${codeStr}) уже зарегистрирован в системе.`);
      }
      codeRes = insRes;
    }
    const row = codeRes.rows[0];
    if (row.status !== 'available') {
      throw new ValidationError(`Код "Честный знак" (${codeStr}) уже использован.`);
    }

    await client.query(
      `UPDATE wms.marking_codes
       SET status='used', used_at=NOW(), used_ref_type=$1, used_ref_id=$2, used_by=$3,
           wb_submit_status='manual_override', wb_override_reason=$4, wb_override_by=$5
       WHERE id=$6`,
      [refType, refId, packerId, String(reason).trim(), supervisor.id, row.id]
    );

    logger.warn(
      { tenantId, itemId, code: codeStr, packerId, supervisorId: supervisor.id, reason },
      'Marking code packed WITHOUT WB submission (supervisor override)'
    );

    const remainingRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND status='available'`,
      [tenantId, itemId]
    );
    return { code: codeStr, wb_submitted: false, manual_override: true, remaining: remainingRes.rows[0].n };
  };

  return dbClient ? doOverride(dbClient) : transaction(doOverride);
}

/** Список кодов, проведённых в обход отправки в WB — требуют ручной привязки в кабинете WB */
async function listPendingManualOverrides({ tenantId, limit = 200 }) {
  const r = await query(
    `SELECT mc.id, mc.code, mc.item_id, i.item_name, i.barcode, mc.used_at, mc.wb_override_reason,
            u1.full_name AS packed_by_name, u2.full_name AS override_by_name
     FROM wms.marking_codes mc
     JOIN wms.items i ON i.id = mc.item_id
     LEFT JOIN wms.users u1 ON u1.id = mc.used_by
     LEFT JOIN wms.users u2 ON u2.id = mc.wb_override_by
     WHERE mc.tenant_id=$1 AND mc.wb_submit_status='manual_override'
     ORDER BY mc.used_at DESC
     LIMIT $2`,
    [tenantId, Math.min(Number(limit) || 200, 1000)]
  );
  return r.rows;
}

/**
 * Аллоцировать qty кодов из пула товара и создать print_job на каждый
 * (doc_type='marking_code') — рядом с обычным стикером товара/ВБ, чтобы оба
 * распечатывались одним и тем же действием сканирования.
 *
 * ЖЁСТКАЯ БЛОКИРОВКА (решение пользователя): если кодов в пуле не хватает,
 * либо не настроен принтер для doc_type='marking_code' — операция (приёмка/
 * упаковка) должна целиком блокироваться, а не продолжаться без стикера ЧЗ.
 * Поэтому здесь бросаем ValidationError вместо soft-fail лога — вызывающий
 * код (packing.service.js/receiving.service.js) НЕ оборачивает этот вызов в
 * try/catch, чтобы ошибка откатила всю транзакцию приёмки/упаковки целиком.
 *
 * dbClient — если передан (client внутри уже открытой транзакции, как в
 * packing.service.js:scanItem, или receiving.service.js), используем его —
 * тогда откат марки произойдёт вместе с откатом всей остальной операции.
 * Если не передан — открываем свою транзакцию только на аллокацию+печать.
 */
async function allocateAndPrint({
  tenantId, clientId, itemId, itemBarcode, itemName,
  qty = 1, refType, refId, userId, employeeId = null, dbClient = null,
}) {
  const q = Math.max(1, Math.round(Number(qty) || 1));

  const doAllocateAndPrint = async (client) => {
    // SELECT ... FOR UPDATE SKIP LOCKED + UPDATE обязаны выполняться в ОДНОЙ
    // транзакции — иначе лок снимается между запросами, и два параллельных
    // скана могут забрать один и тот же код.
    const pickRes = await client.query(
      `SELECT id, code FROM wms.marking_codes
       WHERE tenant_id=$1 AND item_id=$2 AND status='available'
       ORDER BY id LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [tenantId, itemId, q]
    );
    if (pickRes.rowCount < q) {
      // НИЧЕГО не резервируем при недостаче — коды остаются available,
      // операция должна быть полностью отменена и повторена после пополнения пула.
      throw new ValidationError(
        `Товар помечен как требующий маркировки "Честный знак", но в пуле недостаточно кодов ` +
        `(нужно ${q}, доступно ${pickRes.rowCount}). Загрузите коды в пул (в справочнике товара ` +
        `или в кабинете клиента) и повторите операцию.`
      );
    }

    const resolved = await resolvePrinter(client.query.bind(client), {
      tenantId, docType: 'marking_code', employeeId: employeeId || userId, clientId,
    });
    if (!resolved) {
      throw new ValidationError(
        `Не найден принтер для печати кода маркировки "Честный знак" (doc_type=marking_code) — ` +
        `настройте маршрут печати в панели принтеров или рабочее место сотрудника со своим принтером.`
      );
    }

    const ids = pickRes.rows.map(r => r.id);
    await client.query(
      `UPDATE wms.marking_codes SET status='used', used_at=NOW(),
         used_ref_type=$1, used_ref_id=$2, used_by=$3
       WHERE id = ANY($4::bigint[])`,
      [refType, refId, userId, ids]
    );

    const jobIds = [];
    for (const row of pickRes.rows) {
      const svg = generateMarkingLabelSvg(row.code, itemName);
      const jobCode = `MARK-${itemId}-${row.id}-${Date.now()}`;
      const pjRes = await client.query(
        `INSERT INTO wms.print_jobs
           (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
         VALUES($1,$2,$3,$4,'marking_code','item',$5,1,$6::jsonb,'new',$7)
         RETURNING id`,
        [
          tenantId, jobCode, resolved.printerId, resolved.routeId, itemId,
          JSON.stringify({ sticker: svg, code: row.code, barcode: itemBarcode, item_name: itemName }),
          userId,
        ]
      );
      jobIds.push(pjRes.rows[0].id);
    }

    const remainingRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND status='available'`,
      [tenantId, itemId]
    );

    return { allocated: ids.length, shortfall: 0, printed: jobIds.length, jobIds, remaining: remainingRes.rows[0].n };
  };

  return dbClient ? doAllocateAndPrint(dbClient) : transaction(doAllocateAndPrint);
}

/**
 * Выгрузка кодов "Честный знак", ушедших в конкретную поставку WB (одна
 * поставка = один склад WB, см. wms.shipments.external_id = wb_supply_id) —
 * для клиентов с рубильником marking_wb_submit_disabled (см. clients.service.js
 * и consumeScannedCodeAtPacking выше): код упакован и привязан к заказу, но
 * НЕ отправлен в WB — клиент сам заводит эти пары штрихкод/код в Тотал Марк
 * (или в Честный знак напрямую), передаёт право собственности на нужное ИП,
 * и дальше сам решает, довносить ли код в кабинет WB вручную.
 *
 * Возвращает ВСЕ коды по поставке (не только export_only) - так на выгрузке
 * видно целиком, что реально ушло в эту поставку, а не только "недостающую"
 * часть; wb_submit_status в каждой строке показывает, что уже отправлено в WB
 * автоматически, а что ждёт ручной обработки.
 */
async function listCodesForShipment({ tenantId, shipmentExternalId }) {
  const shipRes = await query(
    `SELECT id, external_id, client_id FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 ORDER BY id DESC LIMIT 1`,
    [tenantId, shipmentExternalId]
  );
  if (shipRes.rowCount === 0) throw new ValidationError(`Поставка '${shipmentExternalId}' не найдена`);
  const shipment = shipRes.rows[0];

  // wb_sticker_code (какой стикер WB продан по этому коду) — тот же приём,
  // что и в getShippedReport/getCodesJournal ниже: LATERAL join на wb_orders
  // по (tenant_id, wb_order_id). shipment_code здесь константа для всей
  // выборки (это выгрузка по ОДНОЙ конкретной поставке) - берём его прямо из
  // уже прочитанного shipment.external_id, отдельный join не нужен. Добавлено
  // 01.09.2026 по запросу владельца - раньше в этой выгрузке не было ни
  // поставки, ни стикера, хотя они уже выведены в других отчётах маркировки -
  // без них нельзя было понять, какой стикер продан и какой киз выводить из
  // оборота при возврате/пересорте.
  const r = await query(
    `SELECT mc.code, mc.wb_submit_status, mc.used_at,
            i.barcode, i.item_name, i.vendor_code, i.size,
            wo.wb_sticker_code
     FROM wms.marking_codes mc
     JOIN wms.items i ON i.id = mc.item_id
     LEFT JOIN LATERAL (
       SELECT wo2.wb_sticker_code FROM wms.wb_orders wo2
       WHERE wo2.tenant_id = mc.tenant_id AND wo2.wb_order_id = mc.wb_order_id
       LIMIT 1
     ) wo ON mc.wb_order_id IS NOT NULL
     WHERE mc.tenant_id=$1 AND mc.used_ref_type='packing' AND mc.used_ref_id=$2
     ORDER BY i.item_name, mc.used_at`,
    [tenantId, shipment.id]
  );
  return { shipment, rows: r.rows };
}

/**
 * Общая выгрузка "что реально отгружено в WB и в какой поставке" — в отличие
 * от listCodesForShipment (одна конкретная поставка по её коду), здесь сразу
 * ВСЕ отгруженные коды по тенанту с фильтрами по клиенту/периоду — то, что
 * раньше нужно было смотреть поставку за поставкой вручную. Только 'used'
 * коды (реально ушедшие в заказ на упаковке) - 'available' в отчёт об
 * отгрузке смысла попадать нет.
 */
async function getShippedReport({ tenantId, clientId = null, dateFrom = null, dateTo = null, limit = 5000 }) {
  const params = [tenantId];
  const conds = [`mc.tenant_id=$1`, `mc.status='used'`];
  let idx = 2;
  if (clientId) { conds.push(`s.client_id=$${idx++}`); params.push(Number(clientId)); }
  if (dateFrom) { conds.push(`mc.used_at >= $${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`mc.used_at < ($${idx++}::date + INTERVAL '1 day')`); params.push(dateTo); }
  params.push(Math.min(Number(limit) || 5000, 20000));

  const r = await query(
    `SELECT mc.code, mc.used_at, mc.wb_submit_status, mc.wb_order_id,
            i.barcode, i.item_name, i.vendor_code, i.size,
            s.external_id AS shipment_code, s.marketplace, s.shipped_at,
            c.client_name,
            wo.wb_sticker_code
     FROM wms.marking_codes mc
     JOIN wms.items i ON i.id = mc.item_id
     LEFT JOIN wms.shipments s ON mc.used_ref_type='packing' AND mc.used_ref_id = s.id
     LEFT JOIN wms.clients c ON c.id = s.client_id
     LEFT JOIN LATERAL (
       SELECT wo2.wb_sticker_code FROM wms.wb_orders wo2
       WHERE wo2.tenant_id = mc.tenant_id AND wo2.wb_order_id = mc.wb_order_id
       LIMIT 1
     ) wo ON mc.wb_order_id IS NOT NULL
     WHERE ${conds.join(' AND ')}
     ORDER BY mc.used_at DESC
     LIMIT $${idx}`,
    params
  );
  return { rows: r.rows };
}

/**
 * Общий журнал кодов "Честный знак" — КАЖДЫЙ код тенанта (не только
 * отгруженные, как в getShippedReport), с приходом (created_at + source:
 * импорт в пул / скан на приёмке / скан на упаковке при scan_packing) и
 * расходом (used_at + поставка, если код уже ушёл). Коды, ещё лежащие в
 * пуле, тоже видны - used_at/поставка у них просто пустые. Период фильтрует
 * по ДАТЕ ПРИХОДА (created_at) - это единственное поле, которое есть у
 * КАЖДОГО кода независимо от статуса, в отличие от used_at.
 */
async function getCodesJournal({
  tenantId, clientId = null, barcode = null, status = null,
  dateFrom = null, dateTo = null, limit = 5000,
}) {
  const params = [tenantId];
  const conds = [`mc.tenant_id=$1`];
  let idx = 2;
  if (clientId) { conds.push(`i.client_id=$${idx++}`); params.push(Number(clientId)); }
  if (barcode)  { conds.push(`i.barcode=$${idx++}`); params.push(String(barcode).trim()); }
  if (status && ['available', 'used'].includes(status)) {
    conds.push(`mc.status=$${idx++}`); params.push(status);
  }
  if (dateFrom) { conds.push(`mc.created_at >= $${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`mc.created_at < ($${idx++}::date + INTERVAL '1 day')`); params.push(dateTo); }
  params.push(Math.min(Number(limit) || 5000, 20000));

  const r = await query(
    `SELECT mc.code, mc.status, mc.source, mc.created_at,
            mc.used_at, mc.wb_submit_status, mc.wb_order_id,
            i.barcode, i.item_name, i.vendor_code, i.size,
            c.client_name,
            s.external_id AS shipment_code,
            wo.wb_sticker_code
     FROM wms.marking_codes mc
     JOIN wms.items i ON i.id = mc.item_id
     LEFT JOIN wms.clients c ON c.id = i.client_id
     LEFT JOIN wms.shipments s ON mc.used_ref_type='packing' AND mc.used_ref_id = s.id
     LEFT JOIN LATERAL (
       SELECT wo2.wb_sticker_code FROM wms.wb_orders wo2
       WHERE wo2.tenant_id = mc.tenant_id AND wo2.wb_order_id = mc.wb_order_id
       LIMIT 1
     ) wo ON mc.wb_order_id IS NOT NULL
     WHERE ${conds.join(' AND ')}
     ORDER BY mc.created_at DESC
     LIMIT $${idx}`,
    params
  );
  return { rows: r.rows };
}

module.exports = {
  parseCodesText, importCodes, importCodesFromExcel, getCodesSummary, listCodes, deleteCode,
  shouldMarkAt, allocateAndPrint,
  registerScannedCodes, consumeScannedCodeAtPacking, overrideMarkingAtPacking,
  listPendingManualOverrides, listCodesForShipment, getShippedReport, getCodesJournal,
};
