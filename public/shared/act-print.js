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
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(d) {
    return new Date(d || Date.now()).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  }
  function fmtQty(n) {
    return Number(n || 0).toLocaleString('ru-RU');
  }
  function buildHtml(act, client, tenant, lines) {
    client = client || {};
    tenant = tenant || {};
    var executorName = tenant.legal_name || tenant.company_name || '—';
    var executorInn = tenant.inn ? "\u0418\u041D\u041D ".concat(esc(tenant.inn)) : '';
    var executorOgrnip = tenant.ogrnip ? "\u041E\u0413\u0420\u041D\u0418\u041F ".concat(esc(tenant.ogrnip)) : '';
    var executorAddr = tenant.legal_address || '';
    var clientName = client.legal_name || client.client_name || '—';
    var clientInn = client.inn ? "\u0418\u041D\u041D ".concat(esc(client.inn)) : '';
    var clientAddr = client.legal_address || '';
    var genDate = fmtDate(act.created_at);
    var linesRows = (lines || []).map(function (l, i) {
      return "\n      <tr>\n        <td>".concat(i + 1, "</td>\n        <td>").concat(esc(l.item_name || l.barcode), "</td>\n        <td>\u0448\u0442</td>\n        <td>").concat(l.qty_expected != null ? fmtQty(l.qty_expected) : '—', "</td>\n        <td>").concat(fmtQty(l.qty_received || 0), "</td>\n        <td>").concat(Number(l.qty_damaged || 0) > 0 ? "\u041F\u043E\u0432\u0440\u0435\u0436\u0434\u0435\u043D\u043E: ".concat(l.qty_damaged) : 'без замечаний').concat(l.notes ? '; ' + esc(l.notes) : '', "</td>\n      </tr>\n    ");
    }).join('');
    var sourceLine = act.order_number ? "\u0422\u043E\u0432\u0430\u0440\u043D\u0430\u044F \u043D\u0430\u043A\u043B\u0430\u0434\u043D\u0430\u044F/\u0423\u041F\u0414: ".concat(esc(act.act_source_doc || '—'), ". \u0417\u0430\u044F\u0432\u043A\u0430 \u2116 ").concat(esc(act.order_number), ".") : "\u0422\u043E\u0432\u0430\u0440\u043D\u0430\u044F \u043D\u0430\u043A\u043B\u0430\u0434\u043D\u0430\u044F/\u0423\u041F\u0414: ".concat(esc(act.act_source_doc || '—'), ". \u041F\u0440\u0438\u0451\u043C\u043A\u0430 \u0431\u0435\u0437 \u043F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0439 \u0437\u0430\u044F\u0432\u043A\u0438.");
    return "\n<html><head><meta charset=\"UTF-8\"/><title>\u0410\u043A\u0442 \u043F\u0440\u0438\u0451\u043C\u043A\u0438 ".concat(esc(act.act_number), "</title>\n<style>\n  @page { size: A4; margin: 16mm 14mm; }\n  body { font-family: 'Times New Roman', serif; font-size: 13px; color: #000; }\n  h1 { font-size: 15px; text-align: center; margin: 4px 0 14px; }\n  .hdr-right { text-align: right; font-size: 12px; margin-bottom: 10px; }\n  p { line-height: 1.5; margin: 6px 0; }\n  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 12px; }\n  th, td { border: 1px solid #000; padding: 4px 6px; text-align: left; }\n  th { background: #f0f0f0; }\n  .sect { font-weight: bold; margin-top: 14px; }\n  .sign-row { display: flex; justify-content: space-between; margin-top: 40px; }\n  .sign-col { width: 46%; }\n  .sign-line { border-bottom: 1px solid #000; margin: 30px 0 4px; }\n  @media print { body { -webkit-print-color-adjust: exact; } }\n</style>\n</head>\n<body onload=\"window.print()\">\n  <div class=\"hdr-right\">\u0433. ").concat(esc(act.act_city || '_____'), " &nbsp;&nbsp; \xAB").concat(genDate, "\xBB</div>\n  <h1>\u0410\u041A\u0422 \u041F\u0420\u0418\u0401\u041C\u041A\u0418 \u0422\u041E\u0412\u0410\u0420\u0410 \u041D\u0410 \u0421\u041A\u041B\u0410\u0414 \u2116 ").concat(esc(act.act_number), "</h1>\n\n  <p>\u0417\u0430\u043A\u0430\u0437\u0447\u0438\u043A: <b>").concat(esc(clientName), "</b> ").concat(esc(clientInn)).concat(clientAddr ? ', ' + esc(clientAddr) : '', ",\n  \u043F\u0435\u0440\u0435\u0434\u0430\u043B, \u0430 \u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C: <b>").concat(esc(executorName), "</b> ").concat(esc(executorInn), " ").concat(esc(executorOgrnip)).concat(executorAddr ? ', ' + esc(executorAddr) : '', ",\n  \u043F\u0440\u0438\u043D\u044F\u043B \u043D\u0430 \u0441\u043A\u043B\u0430\u0434 \u0422\u043E\u0432\u0430\u0440, \u043E \u0447\u0451\u043C \u0441\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u0439 \u0410\u043A\u0442 \u043E \u043D\u0438\u0436\u0435\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C:</p>\n\n  <div class=\"sect\">1. \u0421\u043E\u043F\u0440\u043E\u0432\u043E\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442</div>\n  <p>").concat(sourceLine, "</p>\n\n  <div class=\"sect\">2. \u0421\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u043F\u0430\u0440\u0442\u0438\u0438 \u0422\u043E\u0432\u0430\u0440\u0430</div>\n  <table>\n    <tr><th>\u041F\u043E\u0441\u0442\u0430\u0432\u0449\u0438\u043A/\u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C</th><td>").concat(esc(act.act_supplier || '—'), "</td>\n        <th>\u041A\u043E\u043B-\u0432\u043E \u0433\u0440\u0443\u0437\u043E\u0432\u044B\u0445 \u043C\u0435\u0441\u0442</th><td>").concat(act.act_boxes_count != null ? act.act_boxes_count : '—', "</td></tr>\n    <tr><th>\u041A\u043E\u043B-\u0432\u043E \u043F\u0430\u043B\u043B\u0435\u0442</th><td>").concat(act.act_pallets_count != null ? act.act_pallets_count : '—', "</td>\n        <th>\u0412\u0435\u0441, \u043A\u0433</th><td>").concat(act.act_weight_kg != null ? act.act_weight_kg : '—', "</td></tr>\n    <tr><th>\u041F\u0435\u0440\u0435\u0432\u043E\u0437\u0447\u0438\u043A</th><td>").concat(esc(act.act_carrier || act.vehicle_make || '—'), "</td>\n        <th>\u0412\u043E\u0434\u0438\u0442\u0435\u043B\u044C</th><td>").concat(esc(act.driver_name || '—'), "</td></tr>\n  </table>\n\n  <div class=\"sect\">3. \u041F\u0435\u0440\u0435\u0447\u0435\u043D\u044C \u0438 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0422\u043E\u0432\u0430\u0440\u0430</div>\n  <table>\n    <thead><tr><th>\u2116</th><th>\u041D\u0430\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435</th><th>\u0415\u0434. \u0438\u0437\u043C.</th><th>\u041A\u043E\u043B-\u0432\u043E \u043F\u043E \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430\u043C</th><th>\u041A\u043E\u043B-\u0432\u043E \u0444\u0430\u043A\u0442\u0438\u0447\u0435\u0441\u043A\u0438</th><th>\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435/\u043F\u0440\u0438\u043C\u0435\u0447\u0430\u043D\u0438\u044F</th></tr></thead>\n    <tbody>").concat(linesRows, "</tbody>\n  </table>\n\n  <div class=\"sect\">4. \u0412\u043D\u0435\u0448\u043D\u0435\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0443\u043F\u0430\u043A\u043E\u0432\u043A\u0438 \u0438 \u0422\u043E\u0432\u0430\u0440\u0430</div>\n  <p>").concat(act.act_packaging_ok === false ? 'С замечаниями: ' + esc(act.act_remarks || '') : 'Без замечаний.', "</p>\n\n  <div class=\"sect\">5.</div>\n  <p>\u041D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u0439 \u0410\u043A\u0442 \u0441\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D \u0432 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0438 \u0441 \u0443\u0441\u043B\u043E\u0432\u0438\u044F\u043C\u0438 \u0414\u043E\u0433\u043E\u0432\u043E\u0440\u0430 \u0432\u043E\u0437\u043C\u0435\u0437\u0434\u043D\u043E\u0433\u043E \u043E\u043A\u0430\u0437\u0430\u043D\u0438\u044F \u0443\u0441\u043B\u0443\u0433 \u0444\u0443\u043B\u0444\u0438\u043B\u043C\u0435\u043D\u0442\u0430, \u0437\u0430\u043A\u043B\u044E\u0447\u0451\u043D\u043D\u043E\u0433\u043E \u043C\u0435\u0436\u0434\u0443 \u0417\u0430\u043A\u0430\u0437\u0447\u0438\u043A\u043E\u043C \u0438 \u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u0435\u043C.</p>\n\n  <div class=\"sect\">6.</div>\n  <p>\u0410\u043A\u0442 \u0441\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D \u0432 \u0434\u0432\u0443\u0445 \u044D\u043A\u0437\u0435\u043C\u043F\u043B\u044F\u0440\u0430\u0445, \u0438\u043C\u0435\u044E\u0449\u0438\u0445 \u043E\u0434\u0438\u043D\u0430\u043A\u043E\u0432\u0443\u044E \u044E\u0440\u0438\u0434\u0438\u0447\u0435\u0441\u043A\u0443\u044E \u0441\u0438\u043B\u0443, \u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u0434\u043B\u044F \u043A\u0430\u0436\u0434\u043E\u0439 \u0438\u0437 \u0421\u0442\u043E\u0440\u043E\u043D.</p>\n\n  <div class=\"sign-row\">\n    <div class=\"sign-col\">\n      <div><b>\u0421\u0434\u0430\u043B (\u0417\u0430\u043A\u0430\u0437\u0447\u0438\u043A):</b></div>\n      <div class=\"sign-line\"></div>\n      <div>").concat(esc(act.act_client_signer || act.driver_name || ''), " &nbsp; /_________________/</div>\n      <div style=\"margin-top:6px;\">\u043C.\u043F. (\u043F\u0440\u0438 \u043D\u0430\u043B\u0438\u0447\u0438\u0438)</div>\n    </div>\n    <div class=\"sign-col\">\n      <div><b>\u041F\u0440\u0438\u043D\u044F\u043B (\u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C):</b></div>\n      <div class=\"sign-line\"></div>\n      <div>").concat(esc(act.act_operator_signer || ''), " &nbsp; /_________________/</div>\n      <div style=\"margin-top:6px;\">\u043C.\u043F. (\u043F\u0440\u0438 \u043D\u0430\u043B\u0438\u0447\u0438\u0438)</div>\n    </div>\n  </div>\n</body></html>\n    ");
  }

  /** Открыть уже созданное (window.open('', '_blank')) окно и напечатать акт. */
  function printInto(win, act, client, tenant, lines) {
    if (!win) return;
    win.document.open();
    win.document.write(buildHtml(act, client, tenant, lines));
    win.document.close();
  }
  window.ActPrint = {
    buildHtml: buildHtml,
    printInto: printInto
  };
})(window);