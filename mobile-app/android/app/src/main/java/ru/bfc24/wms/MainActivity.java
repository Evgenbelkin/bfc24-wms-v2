package ru.bfc24.wms;

import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * Единственная кастомизация относительно шаблона Capacitor — обработка
 * аппаратной кнопки "Назад".
 *
 * Экран выбора сервера (dev/staging) — это локальная bootstrap-страница
 * (mobile-app/www/index.html), которая после выбора один раз запоминает
 * его в localStorage и сразу уходит в WebView-навигацию на
 * https://<host>/app/login.html. Дальше вся история WebView живёт внутри
 * удалённого origin'а (dev.bfc-24.ru или staging.bfc-24.ru), и штатный
 * "Назад" листает её как обычно.
 *
 * Но когда пользователь долистал назад до самого первого экрана
 * (login.html, дальше в истории WebView ничего нет), обычный Capacitor
 * просто закрыл бы приложение. Чтобы дать способ сменить сервер без
 * похода в настройки Android и очистки данных приложения, в этом случае
 * "Назад" вместо выхода возвращает на локальный экран выбора сервера
 * (с ?reset=1, чтобы он показал выбор заново, а не тут же
 * отредиректил обратно по сохранённому значению).
 */
public class MainActivity extends BridgeActivity {

    private static final String ENTRY_PATH_MARKER = "/app/login.html";
    // Локальный bootstrap-экран (www/index.html) Capacitor подключает по адресу
    // https://<hostname>/ (hostname по умолчанию "localhost", см.
    // capacitor.config.json — androidScheme: "https", hostname не переопределён).
    private static final String RESET_BOOTSTRAP_URL = "https://localhost/index.html?reset=1";

    @Override
    public void onBackPressed() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;

        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }

        String currentUrl = webView != null ? webView.getUrl() : null;
        boolean onEntryScreen = currentUrl != null && currentUrl.contains(ENTRY_PATH_MARKER);

        if (webView != null && onEntryScreen) {
            webView.loadUrl(RESET_BOOTSTRAP_URL);
            return;
        }

        super.onBackPressed();
    }
}
