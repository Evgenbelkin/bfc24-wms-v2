// =============================================================================
// Единый шаблон печати "Акт приёмки товара на склад" (A4, из браузера).
// Используется inbound-orders.html, receiving.html и acts.html — чтобы не
// дублировать вёрстку акта в трёх местах.
//
// buildHtml(act, client, tenant, lines):
//   act    — строка wms.acceptance_acts (act_number, act_city, act_supplier,
//            act_boxes_count, act_pallets_count, act_weight_kg, act_carrier,
//            act_source_doc, act_packaging_ok, act_remarks, act_client_signer,
//            act_operator_signer, driver_name, vehicle_make, created_at, ...)
//   client — { client_name, legal_name, inn, legal_address }
//   tenant — { company_name, legal_name, inn, ogrnip, legal_address }
//   lines  — [{ item_name, barcode, qty_expected, qty_received, qty_damaged, notes }]
// =============================================================================
(function (window) {
  'use strict';

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    return new Date(d || Date.now()).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtQty(n) { return Number(n || 0).toLocaleString('ru-RU'); }

  function buildHtml(act, client, tenant, lines) {
    client = client || {};
    tenant = tenant || {};
    const executorName = tenant.legal_name || tenant.company_name || '—';
    const executorInn = tenant.inn ? `ИНН ${esc(tenant.inn)}` : '';
    const executorOgrnip = tenant.ogrnip ? `ОГРНИП ${esc(tenant.ogrnip)}` : '';
    const executorAddr = tenant.legal_address || '';
    const clientName = client.legal_name || client.client_name || '—';
    const clientInn = client.inn ? `ИНН ${esc(client.inn)}` : '';
    const clientAddr = client.legal_address || '';
    const genDate = fmtDate(act.created_at);

    const linesRows = (lines || []).map((l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(l.item_name || l.barcode)}</td>
        <td>шт</td>
        <td>${l.qty_expected != null ? fmtQty(l.qty_expected) : '—'}</td>
        <td>${fmtQty(l.qty_received || 0)}</td>
        <td>${Number(l.qty_damaged || 0) > 0 ? `Повреждено: ${l.qty_damaged}` : 'без замечаний'}${l.notes ? '; ' + esc(l.notes) : ''}</td>
      </tr>
    `).join('');

    const sourceLine = act.order_number
      ? `Товарная накладная/УПД: ${esc(act.act_source_doc || '—')}. Заявка № ${esc(act.order_number)}.`
      : `Товарная накладная/УПД: ${esc(act.act_source_doc || '—')}. Приёмка без предварительной заявки.`;

    return `
<html><head><meta charset="UTF-8"/><title>Акт приёмки ${esc(act.act_number)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: 'Times New Roman', serif; font-size: 13px; color: #000; }
  h1 { font-size: 15px; text-align: center; margin: 4px 0 14px; }
  .hdr-right { text-align: right; font-size: 12px; margin-bottom: 10px; }
  p { line-height: 1.5; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 12px; }
  th, td { border: 1px solid #000; padding: 4px 6px; text-align: left; }
  th { background: #f0f0f0; }
  .sect { font-weight: bold; margin-top: 14px; }
  .sign-row { display: flex; justify-content: space-between; margin-top: 40px; }
  .sign-col { width: 46%; }
  .sign-line { border-bottom: 1px solid #000; margin: 30px 0 4px; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head>
<body onload="window.print()">
  <div class="hdr-right">г. ${esc(act.act_city || '_____')} &nbsp;&nbsp; «${genDate}»</div>
  <h1>АКТ ПРИЁМКИ ТОВАРА НА СКЛАД № ${esc(act.act_number)}</h1>

  <p>Заказчик: <b>${esc(clientName)}</b> ${esc(clientInn)}${clientAddr ? ', ' + esc(clientAddr) : ''},
  передал, а Исполнитель: <b>${esc(executorName)}</b> ${esc(executorInn)} ${esc(executorOgrnip)}${executorAddr ? ', ' + esc(executorAddr) : ''},
  принял на склад Товар, о чём составлен настоящий Акт о нижеследующем:</p>

  <div class="sect">1. Сопроводительный документ</div>
  <p>${sourceLine}</p>

  <div class="sect">2. Сведения о партии Товара</div>
  <table>
    <tr><th>Поставщик/отправитель</th><td>${esc(act.act_supplier || '—')}</td>
        <th>Кол-во грузовых мест</th><td>${act.act_boxes_count != null ? act.act_boxes_count : '—'}</td></tr>
    <tr><th>Кол-во паллет</th><td>${act.act_pallets_count != null ? act.act_pallets_count : '—'}</td>
        <th>Вес, кг</th><td>${act.act_weight_kg != null ? act.act_weight_kg : '—'}</td></tr>
    <tr><th>Перевозчик</th><td>${esc(act.act_carrier || act.vehicle_make || '—')}</td>
        <th>Водитель</th><td>${esc(act.driver_name || '—')}</td></tr>
  </table>

  <div class="sect">3. Перечень и состояние Товара</div>
  <table>
    <thead><tr><th>№</th><th>Наименование</th><th>Ед. изм.</th><th>Кол-во по документам</th><th>Кол-во фактически</th><th>Состояние/примечания</th></tr></thead>
    <tbody>${linesRows}</tbody>
  </table>

  <div class="sect">4. Внешнее состояние упаковки и Товара</div>
  <p>${act.act_packaging_ok === false ? 'С замечаниями: ' + esc(act.act_remarks || '') : 'Без замечаний.'}</p>

  <div class="sect">5.</div>
  <p>Настоящий Акт составлен в соответствии с условиями Договора возмездного оказания услуг фулфилмента, заключённого между Заказчиком и Исполнителем.</p>

  <div class="sect">6.</div>
  <p>Акт составлен в двух экземплярах, имеющих одинаковую юридическую силу, по одному для каждой из Сторон.</p>

  <div class="sign-row">
    <div class="sign-col">
      <div><b>Сдал (Заказчик):</b></div>
      <div class="sign-line"></div>
      <div>${esc(act.act_client_signer || act.driver_name || '')} &nbsp; /_________________/</div>
      <div style="margin-top:6px;">м.п. (при наличии)</div>
    </div>
    <div class="sign-col">
      <div><b>Принял (Исполнитель):</b></div>
      <div class="sign-line"></div>
      <div>${esc(act.act_operator_signer || '')} &nbsp; /_________________/</div>
      <div style="margin-top:6px;">м.п. (при наличии)</div>
    </div>
  </div>
</body></html>
    `;
  }

  /** Открыть уже созданное (window.open('', '_blank')) окно и напечатать акт. */
  function printInto(win, act, client, tenant, lines) {
    if (!win) return;
    win.document.open();
    win.document.write(buildHtml(act, client, tenant, lines));
    win.document.close();
  }

  window.ActPrint = { buildHtml, printInto };
})(window);
